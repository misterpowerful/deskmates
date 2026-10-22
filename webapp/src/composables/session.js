import { reactive } from "vue";
import { pipelineState } from "./pipelineState.js";
import { displayModeFor } from "./effectiveMode.js";
import { formatTurnStats } from "./turnStats.js";
import { logSent, logRecv, logSys, logErr } from "./useProtocolLog.js";
import { transcript, addTranscriptTurn, resolveTranscriptTurn, registerPersonalityDisplayName, clearTranscript } from "./useTranscript.js";
import { pairTurnsForHydration } from "./conversationHistoryHydration.js";
import { isUnexpectedClose, nextReconnectDelay } from "./reconnect.js";
import { shouldSurfaceTurnError, formatTurnErrorText } from "./turnErrorPolicy.js";
import { parseTaskNotification } from "./taskNotifications.js";

const TOKEN_KEY = "deskmates_token";
const SESSION_ID_KEY = "deskmates_session_id";

// The mode value sent with every speech_request/get_canned. The wire
// protocol's live mode values are "friendly", "sentry_intruder", and the
// transient server-derived "deep_thoughtful" override (see
// resolveEffectiveMode in speechPipeline.js) — but which of those applies to
// a given household member is normally decided by the physical bot's own
// camera/face-recognition pipeline, which a phone has no equivalent of. This
// web client is a direct line for an already-authorized person, so it always
// requests "friendly" rather than exposing a mode picker with no reliable
// way to drive it.
export const DEFAULT_MODE = "friendly";
pipelineState.mode = DEFAULT_MODE;

export const session = reactive({
  connectionState: "disconnected", // 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'
  token: localStorage.getItem(TOKEN_KEY) || "",
  personalities: [],
  activePersonality: "",
  llmOptions: [],
  activeLlm: "",
  // slug -> display name, mirrors useTranscript's knownDisplayNames but kept
  // reactive so UI (e.g. a "bot name" settings drawer) can bind to it
  // directly instead of needing to re-derive it on every render.
  displayNames: {},
  // Most recent task_notification not yet shown as a toast, or null — set by
  // handleJsonMessage below, watched and cleared by App.vue (which has the
  // Quasar context $q.notify needs and this plain module doesn't).
  lastTaskNotification: null,
});

// Single write path for a learned/confirmed display name: keeps
// useTranscript's own (non-reactive) lookup and session.displayNames in
// sync so neither can drift from the other.
function setKnownDisplayName(slug, displayName) {
  registerPersonalityDisplayName(slug, displayName);
  if (slug && typeof displayName === "string" && displayName.trim()) {
    session.displayNames[slug] = displayName.trim();
  }
}

function readOrCreateSessionId() {
  let id = localStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}
const sessionId = readOrCreateSessionId();

export function setToken(token) {
  session.token = token;
  localStorage.setItem(TOKEN_KEY, token);
}

// Shared fetch for the read-only REST API (Turns/Costs tabs). Validates
// content-type before parsing JSON — a misrouted request (nginx serving the
// SPA's index.html for an unmatched path, say) can come back 200 OK with an
// HTML body, and res.json() on that throws Safari's opaque "The string did
// not match the expected pattern" instead of anything actionable. Surfacing
// the real HTTP status and a body snippet here means that failure mode is
// diagnosable from the UI instead of only from devtools.
export async function apiFetch(path, params = {}) {
  const query = new URLSearchParams({ ...params, token: session.token });
  const res = await fetch(`${path}?${query}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("application/json")) {
    if (res.status === 401) throw new Error("Unauthorized — check token");
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `Request failed (${res.status} ${contentType || "no content-type"})${snippet ? `: ${snippet}` : ""}`,
    );
  }
  return res.json();
}

// JSON POST counterpart to apiFetch, used by the queue drawer. Surfaces the
// server's own error message (e.g. "order does not match the current
// pending queue") rather than a bare status.
export async function apiPost(path, body) {
  const res = await fetch(`${path}?${new URLSearchParams({ token: session.token })}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

let ws = null;
let msgCounter = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${++msgCounter}`;

// id -> { category, mode, isFiller } for outstanding get_canned/speech_request
// calls, consumed when the matching JSON header arrives.
const outstandingRequests = new Map();

// FIFO of header info, shifted off when the binary frame that always follows
// it (header-then-binary, one pair per request) arrives — mirrors the
// console's own pendingResponses queue, extended with `kind` so playback
// routing (see useAutoConversation.js) doesn't have to guess "filler vs real
// reply" from the JSON message type alone. A canned_result can legitimately
// *be* the real reply (the memory-trigger ack path in speechPipeline.js
// returns kind:"canned" for what is, conversationally, this turn's answer) —
// keying off whether *we* requested it as a filler is the only way to tell
// those apart correctly.
const pendingResponses = [];

// Called once by useAutoConversation.js to receive binary frames as they
// arrive, tagged 'filler' | 'reply'. Session code never imports the
// conversation loop directly, avoiding a circular dependency.
let binaryHandler = null;
export function onBinaryFrame(handler) {
  binaryHandler = handler;
}

// Same wiring as onBinaryFrame, but for the non-filler canned_error/
// speech_error case below — lets useAutoConversation.js abort the
// in-progress VAD turn and return to listening the moment the failure is
// known, instead of only finding out once its own response-safety timer
// times out (up to 120s for a deep_thoughtful turn — see
// replyWaitPolicy.js). Called with (msg.type, msg.reason).
let turnErrorHandler = null;
export function onTurnError(handler) {
  turnErrorHandler = handler;
}

// Same wiring, for a failed set_personality_display_name — PersonalityNamesDrawer.vue
// registers this so a rejected rename (empty name, unknown slug, etc.) clears
// its stuck "saving" spinner and shows an inline error, instead of the
// generic "error" frame only ever reaching the hidden Log panel (see the
// "error" case in handleJsonMessage below). Called with (name, reason).
let renameErrorHandler = null;
export function onPersonalityRenameError(handler) {
  renameErrorHandler = handler;
}

function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logErr("not connected");
    return;
  }
  const text = JSON.stringify(obj);
  ws.send(text);
  logSent(text);
}

export function sendGetCanned(category, { isFiller = false } = {}) {
  const id = nextId("canned");
  outstandingRequests.set(id, { category, mode: DEFAULT_MODE, isFiller });
  sendJson({ type: "get_canned", id, category, mode: DEFAULT_MODE, raw: true });
  return id;
}

export function sendSpeechRequest(pcmArrayBuffer) {
  const id = nextId("speech");
  outstandingRequests.set(id, { category: null, mode: DEFAULT_MODE, isFiller: false });
  sendJson({ type: "speech_request", id, mode: DEFAULT_MODE, raw: true });
  ws.send(pcmArrayBuffer);
  logSent(`[binary frame, ${pcmArrayBuffer.byteLength} bytes from mic]`);
  return id;
}

// Text-only pipeline test: no STT-in, no TTS-out, no binary frame either
// direction — the reply lands purely as a text_result JSON message, so
// unlike sendSpeechRequest/sendGetCanned this never touches
// pendingResponses/onBinaryFrame at all. The user's line is added to the
// transcript immediately (pending:true, shown as a "typing…" placeholder)
// rather than waiting for the round trip, and the outstanding-request entry
// keeps a reference to that turn so the matching text_result/text_error
// fills it in rather than appending a second turn.
export function sendTextRequest(text) {
  const id = nextId("text");
  const turn = addTranscriptTurn({
    user_text: text,
    bot_text: null,
    mode: DEFAULT_MODE,
    personality: session.activePersonality,
    is_filler: false,
    pending: true,
  });
  outstandingRequests.set(id, { category: null, mode: DEFAULT_MODE, isFiller: false, turn });
  sendJson({ type: "text_request", id, mode: DEFAULT_MODE, text });
  return id;
}

export function setPersonality(name) {
  sendJson({ type: "set_personality", id: nextId("setpers"), name });
}

export function setLlm(name) {
  sendJson({ type: "set_llm", id: nextId("setllm"), name });
}

// Renames a personality's friendly display_name (does not switch which one
// is active). Success updates session.displayNames via
// personality_display_name_result below; failure routes through the generic
// "error" case, which (via outstandingRequests' kind:"display_name" tag) also
// calls renameErrorHandler so PersonalityNamesDrawer.vue can clear its
// "saving" spinner instead of leaving it stuck.
export function setPersonalityDisplayName(name, displayName) {
  const id = nextId("dispname");
  // Tagged (not just left in outstandingRequests' canned/speech shape) so the
  // generic "error" handler below can tell a failed rename apart from any
  // other request sharing the same id space and route it to renameErrorHandler.
  outstandingRequests.set(id, { kind: "display_name", name });
  sendJson({ type: "set_personality_display_name", id, name, display_name: displayName });
}

function handlePersonalitiesResult(msg) {
  session.personalities = msg.personalities;
  session.activePersonality = msg.active;
  if (msg.display_names && typeof msg.display_names === "object") {
    for (const [slug, name] of Object.entries(msg.display_names)) {
      setKnownDisplayName(slug, name);
    }
  }
}

function handlePersonalityResult(msg) {
  session.activePersonality = msg.active_personality;
  logSys(`active personality is now "${msg.active_personality}"`);
}

function handleLlmsResult(msg) {
  session.llmOptions = msg.options;
  session.activeLlm = msg.active;
}

function handleLlmResult(msg) {
  session.activeLlm = msg.active;
  logSys(`active llm is now "${msg.active}"`);
}

function handlePersonalityDisplayNameResult(msg) {
  outstandingRequests.delete(msg.id);
  setKnownDisplayName(msg.name, msg.display_name);
  logSys(`display name for "${msg.name}" is now "${msg.display_name}"`);
}

function handleJsonMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    logErr("received unparseable JSON message");
    return;
  }

  switch (msg.type) {
    case "personalities_result":
      handlePersonalitiesResult(msg);
      return;
    case "personality_result":
      handlePersonalityResult(msg);
      return;
    case "llms_result":
      handleLlmsResult(msg);
      return;
    case "llm_result":
      handleLlmResult(msg);
      return;
    case "personality_display_name_result":
      handlePersonalityDisplayNameResult(msg);
      return;
    case "canned_result": {
      const req = outstandingRequests.get(msg.id);
      outstandingRequests.delete(msg.id);
      const isFiller = req?.isFiller ?? false;
      pendingResponses.push({ kind: isFiller ? "filler" : "reply", raw: !!msg.raw });
      addTranscriptTurn({
        user_text: null,
        bot_text: msg.text,
        mode: req?.mode ?? pipelineState.mode,
        personality: session.activePersonality,
        is_filler: isFiller,
      });
      return;
    }
    case "speech_result": {
      const req = outstandingRequests.get(msg.id);
      outstandingRequests.delete(msg.id);
      const turnMode = displayModeFor(msg, req?.mode ?? DEFAULT_MODE);
      pipelineState.mode = turnMode;
      pendingResponses.push({ kind: "reply", raw: !!msg.raw });
      logSys(`turn stats: ${formatTurnStats(msg.turn_stats)}`);
      setKnownDisplayName(msg.personality, msg.personality_display_name);
      addTranscriptTurn({
        user_text: msg.user_text,
        bot_text: msg.text,
        mode: turnMode,
        personality: session.activePersonality,
        is_filler: false,
      });
      return;
    }
    case "text_result": {
      const req = outstandingRequests.get(msg.id);
      outstandingRequests.delete(msg.id);
      const turnMode = displayModeFor(msg, req?.mode ?? DEFAULT_MODE);
      pipelineState.mode = turnMode;
      logSys(`turn stats: ${formatTurnStats(msg.turn_stats)}`);
      setKnownDisplayName(msg.personality, msg.personality_display_name);
      if (req?.turn) {
        resolveTranscriptTurn(req.turn, msg.text, turnMode);
      } else {
        addTranscriptTurn({
          user_text: null,
          bot_text: msg.text,
          mode: turnMode,
          personality: session.activePersonality,
          is_filler: false,
        });
      }
      return;
    }
    case "text_error": {
      const req = outstandingRequests.get(msg.id);
      outstandingRequests.delete(msg.id);
      if (req?.turn) {
        resolveTranscriptTurn(req.turn, `(error: ${msg.reason ?? "request failed"})`);
      }
      logErr(`text_error: ${msg.reason ?? "(no reason given)"}`);
      return;
    }
    // canned_error/speech_error: whether this is worth a visible transcript
    // row (as opposed to a Log-panel-only entry) depends on whether the
    // request it resolves was a filler or the actual turn the person was
    // waiting on — see shouldSurfaceTurnError. Plain "error" (protocol-level
    // failures like a malformed message or "busy, try again") has no such
    // distinction to make and stays log-only, same as before.
    case "canned_error":
    case "speech_error": {
      const req = outstandingRequests.get(msg.id);
      outstandingRequests.delete(msg.id);
      logErr(`${msg.type}: ${msg.reason ?? "(no reason given)"}`);
      if (shouldSurfaceTurnError(req)) {
        addTranscriptTurn({
          user_text: null,
          bot_text: formatTurnErrorText(msg.reason),
          mode: req?.mode ?? pipelineState.mode,
          personality: session.activePersonality,
          is_filler: false,
        });
        turnErrorHandler?.(msg.type, msg.reason);
      }
      return;
    }
    case "error": {
      const req = outstandingRequests.get(msg.id);
      outstandingRequests.delete(msg.id);
      logErr(`error: ${msg.reason ?? "(no reason given)"}`);
      if (req?.kind === "display_name") {
        renameErrorHandler?.(req.name, msg.reason);
      }
      return;
    }
    // A delegated task finishing while this connection's open (src/
    // delegatedTasks.js's notifyTaskDone, broadcast via src/consoleLink.js)
    // — visual-only, never spoken, same rule as the physical bot's chime.
    case "task_notification": {
      const parsed = parseTaskNotification(msg);
      if (parsed) session.lastTaskNotification = parsed;
      return;
    }
    default:
      logErr(`unknown message type: ${JSON.stringify(msg.type)}`);
  }
}

function handleBinaryMessage(arrayBuffer) {
  const pending = pendingResponses.shift();
  const bytes = arrayBuffer.byteLength;
  logRecv(`[binary frame, ${bytes} bytes${pending?.raw ? ", raw PCM" : ""}]`);
  if (!pending) {
    logErr("received a binary frame with no pending response header");
    return;
  }
  binaryHandler?.(pending.kind, new Uint8Array(arrayBuffer));
}

// Reconnect bookkeeping. `reconnectAttempt` drives the backoff delay (see
// reconnect.js) and also which connectionState a fresh connect() reports —
// 0 means this is the first attempt ("connecting"), >0 means it's a retry
// after an unexpected drop ("reconnecting"). `manualDisconnect` is set by
// disconnect() so the close handler it triggers doesn't schedule a retry —
// isUnexpectedClose's code/reason check alone isn't reliable here because a
// close() issued before the handshake finishes doesn't reliably surface the
// code/reason it was given (browsers report 1006 instead).
let reconnectTimer = null;
let reconnectAttempt = 0;
let manualDisconnect = false;

// Guards pullTodayHistory() against overlapping clicks (e.g. a slow fetch
// still in flight) — not session-lifetime state like the old
// hasHydratedHistory flag this replaced, since this is now a repeatable
// user action rather than a once-per-page-load autorun.
export const historyPull = reactive({ loading: false, error: "" });

// Explicit "pull today" action (TranscriptPanel's toolbar button): replaces
// whatever's in the Transcript with this session's own turns from local
// midnight onward (GET /api/conversation?since=..., backed by
// src/conversationHistory.js). A plain page refresh no longer does this on
// its own — see WEBAPP.md's "Persistent conversation history" for why it
// used to and why that was a bug (it replayed a browser's entire lifetime
// history, growing every reload, not just today's).
export async function pullTodayHistory() {
  if (historyPull.loading) return;
  historyPull.loading = true;
  historyPull.error = "";
  try {
    const since = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const { turns } = await apiFetch("/api/conversation", { session_id: sessionId, since });
    clearTranscript();
    for (const { user_text, bot_text } of pairTurnsForHydration(turns)) {
      addTranscriptTurn({ user_text, bot_text, mode: DEFAULT_MODE, personality: session.activePersonality });
    }
  } catch (err) {
    historyPull.error = err.message;
    logErr(`failed to pull today's history: ${err.message}`);
  } finally {
    historyPull.loading = false;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  reconnectAttempt += 1;
  const delay = nextReconnectDelay(reconnectAttempt);
  session.connectionState = "reconnecting";
  logSys(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function connect() {
  if (ws) return;
  if (!session.token) {
    logErr("no token set — cannot connect");
    return;
  }
  clearReconnectTimer();
  manualDisconnect = false;
  session.connectionState = reconnectAttempt > 0 ? "reconnecting" : "connecting";
  outstandingRequests.clear();
  pendingResponses.length = 0;

  // Reuses the same client-generated sessionId on every attempt, including
  // retries, so a reconnect is recognizable as the same client rather than
  // a fresh unrelated one (log correlation only today — see WEBAPP.md).
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/?token=${encodeURIComponent(session.token)}&client=console&session_id=${encodeURIComponent(sessionId)}`;
  logSys(`connecting to ${proto}//${location.host}/`);

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    session.connectionState = "connected";
    reconnectAttempt = 0;
    logSys("connection open");
    sendJson({ type: "list_personalities", id: nextId("personalities") });
    sendJson({ type: "list_llms", id: nextId("llms") });
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      logRecv(ev.data);
      handleJsonMessage(ev.data);
    } else {
      handleBinaryMessage(ev.data);
    }
  });

  ws.addEventListener("close", (ev) => {
    session.personalities = [];
    logSys(`connection closed (code ${ev.code}${ev.reason ? ", " + ev.reason : ""})`);
    ws = null;
    if (!manualDisconnect && isUnexpectedClose(ev)) {
      scheduleReconnect();
    } else {
      session.connectionState = "disconnected";
    }
  });

  ws.addEventListener("error", () => {
    session.connectionState = "error";
    logErr("WebSocket error — see browser devtools network tab for detail");
  });
}

export function disconnect() {
  manualDisconnect = true;
  reconnectAttempt = 0;
  clearReconnectTimer();
  if (ws) {
    ws.close(1000, "manual disconnect");
  } else {
    session.connectionState = "disconnected";
  }
}
