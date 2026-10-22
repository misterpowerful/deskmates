import { reactive } from "vue";
import { pipelineState } from "./pipelineState.js";
import { attachAudioLevel, detachAudioLevel } from "./useAudioLevel.js";
import { logSys, logErr } from "./useProtocolLog.js";
import { sendGetCanned, sendSpeechRequest, onBinaryFrame, onTurnError } from "./session.js";
import { responseSafetyTimeoutMs, recordReplyLatency } from "./replyWaitPolicy.js";

// Ported from the console's auto-conversation-mode VAD loop (public/index.html),
// with one deliberate behavior change: NO inactivity hangup timer. The
// console auto-disables itself after 5s of silence; this app's mic is meant
// to stay open indefinitely until the user explicitly stops it (spec: "tap
// again to stop — only thing that closes it"), so that timer is dropped
// entirely rather than ported.
const VAD_THRESHOLD = 0.02;
const VAD_END_OF_UTTERANCE_MS = 700;
const VAD_SLOW_RESPONSE_MS = 3800;
const VAD_QUEUED_REPLY_PAUSE_MS = 500;

export const autoConversation = reactive({ active: false });

// Set when start() never gets as far as "listening" (getUserMedia rejected)
// or an in-progress recording can't even begin (MediaRecorder construction
// threw) — both happen before any WebSocket turn exists, so turnErrorPolicy.js's
// transcript-row path doesn't apply. logErr() already records the raw reason
// in the hidden Log panel; this is the additional, always-visible surface:
// App.vue's micHint shows this message instead of "Tap to start talking"
// whenever it's set. Cleared at the top of every start() attempt so tapping
// the mic again clears a stale message regardless of outcome.
export const micStartError = reactive({ message: null });

// error.name values the getUserMedia spec uses for a denied/revoked mic
// grant; every other rejection (no device present, hardware busy, an
// insecure/iframe context, etc.) reads as "no microphone found" instead,
// which is close enough for a one-line hint.
const PERMISSION_ERROR_NAMES = new Set(["NotAllowedError", "PermissionDeniedError", "SecurityError"]);

export function describeMicStartError(error) {
  return PERMISSION_ERROR_NAMES.has(error?.name)
    ? "Microphone access is blocked — check your browser settings"
    : "No microphone found";
}

let vadStream = null;
let vadAudioCtx = null;
let vadAnalyser = null;
let vadDataArray = null;
let micSourceNode = null; // re-attached for the level meter whenever we return to "listening"
let vadRafId = null;
let vadRecorder = null;
let vadRecordedChunks = [];
let recording = false; // true from beginUtteranceRecording() until the recorder actually stops

// Guards against a second start() proceeding past the active-check while a
// first call is still awaiting getUserMedia() (autoConversation.active isn't
// set until that resolves) — without it, two quick toggle() taps race to
// stomp the module-level vadStream/vadAudioCtx/vadRafId, leaking a
// stream/RAF loop from whichever call loses.
let isStarting = false;

let silenceTimer = null;
let responseSafetyTimer = null;
let slowResponseTimer = null;
let fillerPlayback = null; // { source, ended } | null
let realReplyStarted = false;
let requestSentAt = null; // Date.now() when the current turn's speech_request went out, for latency tracking

// Dedicated to playback, created on the start() tap (a user gesture) and
// reused for every playPCM() call for the rest of the session — see the
// console's identical ensurePlaybackAudioContext() for why this matters on
// Safari: an AudioContext can only be created/resumed synchronously inside a
// gesture's call stack, and every later playback happens from an async
// WebSocket handler instead.
let playbackAudioCtx = null;

function ensurePlaybackAudioContext() {
  if (!playbackAudioCtx || playbackAudioCtx.state === "closed") {
    playbackAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  playbackAudioCtx.resume();
  return playbackAudioCtx;
}

// Decodes whatever the browser recorded (webm/opus, typically) and
// resamples/downmixes it to exactly 16kHz mono 16-bit PCM, little-endian, no
// container — the raw format the server expects from the bot itself.
async function encodeToPcm16Mono16k(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    decodeCtx.close();
  }

  const targetRate = 16000;
  const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();

  const floatData = rendered.getChannelData(0);
  const pcm = new ArrayBuffer(floatData.length * 2);
  const view = new DataView(pcm);
  for (let i = 0; i < floatData.length; i++) {
    const s = Math.max(-1, Math.min(1, floatData[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return pcm;
}

async function playPCM(pcmBytes, sampleRate = 16000) {
  const ctx = ensurePlaybackAudioContext();
  await ctx.resume();

  const frameCount = Math.max(1, Math.floor(pcmBytes.length / 2));
  const audioBuffer = ctx.createBuffer(1, frameCount, sampleRate);
  const channel = audioBuffer.getChannelData(0);
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  for (let i = 0; i < frameCount; i++) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  attachAudioLevel(ctx, source); // visual level during "speaking" tracks actual playback amplitude
  source.connect(ctx.destination);
  const ended = new Promise((resolve) => {
    source.onended = resolve;
  });
  source.start();
  return { source, ended };
}

function stopPlayback(handle) {
  if (!handle) return;
  try {
    handle.source.stop();
  } catch {
    /* already stopped/ended */
  }
}

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}
function armSilenceTimer() {
  clearSilenceTimer();
  silenceTimer = setTimeout(() => finalizeUtterance(), VAD_END_OF_UTTERANCE_MS);
}

function clearResponseSafetyTimer() {
  if (responseSafetyTimer) {
    clearTimeout(responseSafetyTimer);
    responseSafetyTimer = null;
  }
}
// `mode` should be the last known effective mode (pipelineState.mode) at
// arm time, not the mode the request was sent with — see
// responseSafetyTimeoutMs() in replyWaitPolicy.js for why that distinction
// matters for deep_thoughtful turns.
function armResponseSafetyTimer(mode) {
  clearResponseSafetyTimer();
  responseSafetyTimer = setTimeout(() => {
    logErr("no reply audio arrived in time — resuming listening");
    returnToListening();
  }, responseSafetyTimeoutMs(mode));
}

function clearSlowResponseTimer() {
  if (slowResponseTimer) {
    clearTimeout(slowResponseTimer);
    slowResponseTimer = null;
  }
}
function armSlowResponseTimer() {
  clearSlowResponseTimer();
  slowResponseTimer = setTimeout(() => {
    slowResponseTimer = null;
    sendGetCanned("filler", { isFiller: true });
  }, VAD_SLOW_RESPONSE_MS);
}

function vadTick() {
  if (!autoConversation.active) return;
  vadAnalyser.getFloatTimeDomainData(vadDataArray);
  let sum = 0;
  for (let i = 0; i < vadDataArray.length; i++) sum += vadDataArray[i] * vadDataArray[i];
  const rms = Math.sqrt(sum / vadDataArray.length);

  if (pipelineState.state === "listening") {
    if (!recording && rms >= VAD_THRESHOLD) {
      beginUtteranceRecording();
    } else if (recording) {
      if (rms >= VAD_THRESHOLD) clearSilenceTimer();
      else if (!silenceTimer) armSilenceTimer();
    }
  }

  vadRafId = requestAnimationFrame(vadTick);
}

function beginUtteranceRecording() {
  recording = true;
  vadRecordedChunks = [];
  try {
    vadRecorder = new MediaRecorder(vadStream);
  } catch (e) {
    logErr("MediaRecorder unsupported: " + e.message);
    stop();
    micStartError.message = "Recording isn't supported on this device";
    return;
  }
  vadRecorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) vadRecordedChunks.push(e.data);
  });
  vadRecorder.addEventListener("stop", onUtteranceRecorderStop);
  vadRecorder.start();
  logSys("speech detected, recording…");
}

function finalizeUtterance() {
  clearSilenceTimer();
  if (vadRecorder && vadRecorder.state === "recording") {
    pipelineState.state = "thinking"; // gate the mic immediately, don't wait for the round trip
    vadRecorder.stop();
  }
}

async function onUtteranceRecorderStop() {
  const blob = new Blob(vadRecordedChunks, { type: vadRecorder.mimeType || "audio/webm" });
  vadRecordedChunks = [];
  vadRecorder = null;
  recording = false;
  if (!autoConversation.active) return;

  if (blob.size === 0) {
    logErr("empty utterance, skipping");
    returnToListening();
    return;
  }

  try {
    const pcm = await encodeToPcm16Mono16k(blob);
    fillerPlayback = null;
    realReplyStarted = false;
    requestSentAt = Date.now();
    sendSpeechRequest(pcm);
    armSlowResponseTimer();
    armResponseSafetyTimer(pipelineState.mode);
  } catch (e) {
    logErr("failed to process utterance: " + e.message);
    returnToListening();
  }
}

function handleFillerFrame(pcmBytes) {
  if (pipelineState.state !== "thinking" || realReplyStarted) return;
  playPCM(pcmBytes)
    .then((handle) => {
      pipelineState.state = "speaking";
      fillerPlayback = handle;
      handle.ended.then(() => {
        if (fillerPlayback === handle) {
          fillerPlayback = null;
          if (autoConversation.active && !realReplyStarted) pipelineState.state = "thinking";
        }
      });
    })
    .catch((e) => logErr("filler playback failed: " + e.message));
}

function handleReplyFrame(pcmBytes) {
  if (pipelineState.state !== "thinking" && pipelineState.state !== "speaking") return;
  realReplyStarted = true;
  // pipelineState.mode was already updated to this turn's effective mode by
  // session.js's speech_result handler, which always runs (JSON header)
  // before this binary frame does — see displayModeFor() there.
  if (requestSentAt != null) {
    recordReplyLatency(pipelineState.mode, Date.now() - requestSentAt);
    requestSentAt = null;
  }
  clearResponseSafetyTimer();
  clearSlowResponseTimer();

  if (fillerPlayback) {
    const filler = fillerPlayback;
    filler.ended.then(() => {
      setTimeout(() => {
        if (autoConversation.active) playRealReply(pcmBytes);
      }, VAD_QUEUED_REPLY_PAUSE_MS);
    });
  } else {
    playRealReply(pcmBytes);
  }
}

function playRealReply(pcmBytes) {
  pipelineState.state = "speaking";
  playPCM(pcmBytes)
    .then((handle) => handle.ended.then(() => returnToListening()))
    .catch((e) => {
      logErr("playback failed: " + e.message);
      returnToListening();
    });
}

onBinaryFrame((kind, pcmBytes) => {
  if (!autoConversation.active) return;
  if (kind === "filler") handleFillerFrame(pcmBytes);
  else handleReplyFrame(pcmBytes);
});

// A non-filler canned_error/speech_error (session.js's onTurnError, gated by
// shouldSurfaceTurnError there) means the turn this loop was waiting on has
// definitively failed — no reply audio is ever coming for it. Stop any
// filler still playing (otherwise its own "ended" handler would wrongly flip
// the state back to "thinking", reviving a turn that's already over — see
// handleFillerFrame) and return to listening right away instead of leaving
// the mic gated until the response-safety timer eventually gives up (up to
// 120s for a deep_thoughtful turn).
onTurnError((type, reason) => {
  if (!autoConversation.active) return;
  logErr(`${type}: ${reason ?? "(no reason given)"} — resuming listening`);
  clearSlowResponseTimer();
  if (fillerPlayback) {
    stopPlayback(fillerPlayback);
    fillerPlayback = null;
  }
  returnToListening();
});

function returnToListening() {
  if (!autoConversation.active) return;
  clearResponseSafetyTimer();
  requestSentAt = null;
  pipelineState.state = "listening";
  if (vadAudioCtx && micSourceNode) attachAudioLevel(vadAudioCtx, micSourceNode); // hand the level meter back from playback to the mic
}

export async function start() {
  if (autoConversation.active || isStarting) return;
  isStarting = true;
  micStartError.message = null;
  try {
    // Must happen synchronously, before the getUserMedia await, so context
    // creation/resume stays inside this call's user-gesture call stack.
    ensurePlaybackAudioContext();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      logErr("microphone access denied or unavailable: " + e.message);
      micStartError.message = describeMicStartError(e);
      return;
    }

    vadStream = stream;
    vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Unlike playbackAudioCtx, this context is created after the
    // getUserMedia await, i.e. outside the click handler's synchronous
    // gesture call stack — so on some browsers/stop-start cycles it can land
    // "suspended" with no autoplay-policy prompt to unstick it. Left
    // unresumed, the AnalyserNode reads silence forever and
    // pipelineState.state sticks on "listening".
    await vadAudioCtx.resume();
    logSys("vadAudioCtx state after resume: " + vadAudioCtx.state);
    const source = vadAudioCtx.createMediaStreamSource(vadStream);
    micSourceNode = source;
    vadAnalyser = vadAudioCtx.createAnalyser();
    vadAnalyser.fftSize = 1024;
    vadDataArray = new Float32Array(vadAnalyser.fftSize);
    source.connect(vadAnalyser); // analysis only, never connected to destination
    attachAudioLevel(vadAudioCtx, source); // drives pipelineState.level while listening/recording

    autoConversation.active = true;
    logSys("conversation mode enabled — speak to begin");
    pipelineState.state = "listening";
    vadRafId = requestAnimationFrame(vadTick);
  } finally {
    isStarting = false;
  }
}

export function stop() {
  autoConversation.active = false;
  clearSilenceTimer();
  clearResponseSafetyTimer();
  clearSlowResponseTimer();
  if (vadRafId) {
    cancelAnimationFrame(vadRafId);
    vadRafId = null;
  }
  if (vadRecorder && vadRecorder.state === "recording") vadRecorder.stop();
  vadRecorder = null;
  recording = false;
  if (fillerPlayback) {
    stopPlayback(fillerPlayback);
    fillerPlayback = null;
  }
  realReplyStarted = false;
  requestSentAt = null;
  vadStream?.getTracks().forEach((t) => t.stop());
  vadStream = null;
  vadAudioCtx?.close();
  vadAudioCtx = null;
  vadAnalyser = null;
  micSourceNode = null;
  detachAudioLevel();
  // playbackAudioCtx is intentionally left open so a later start() can
  // resume it rather than needing a fresh one.
  pipelineState.state = "idle";
  logSys("conversation mode disabled");
}

export function toggle() {
  if (autoConversation.active) stop();
  else start();
}
