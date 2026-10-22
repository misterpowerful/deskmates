import { pipelineState } from "./pipelineState.js";

// Wraps an AnalyserNode on whatever audio stream is currently "active" (the
// mic while listening/recording, the playback source while speaking) and
// writes a smoothed 0-1 RMS amplitude into pipelineState.level on every
// animation frame. Only one source is ever attached at a time — attach()
// tears down whatever was attached before.
const REFERENCE_RMS = 0.3; // same normalization console's VAD meter used
const SMOOTHING = 0.35; // exponential smoothing factor per frame

let analyser = null;
let dataArray = null;
let rafId = null;
let smoothed = 0;

function tick() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
  const rms = Math.sqrt(sum / dataArray.length);
  const normalized = Math.min(1, rms / REFERENCE_RMS);
  smoothed = smoothed + (normalized - smoothed) * SMOOTHING;
  pipelineState.level = smoothed;
  rafId = requestAnimationFrame(tick);
}

// audioCtx: an AudioContext. sourceNode: any AudioNode to analyze (a
// MediaStreamSource for the mic, or a BufferSource for playback). Returns a
// detach() cleanup; attaching a new source implicitly detaches the old one.
export function attachAudioLevel(audioCtx, sourceNode) {
  detachAudioLevel();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  dataArray = new Float32Array(analyser.fftSize);
  sourceNode.connect(analyser);
  rafId = requestAnimationFrame(tick);
  return detachAudioLevel;
}

export function detachAudioLevel() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  analyser = null;
  dataArray = null;
  smoothed = 0;
  pipelineState.level = 0;
}
