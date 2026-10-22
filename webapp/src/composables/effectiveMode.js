// Which mode the visualizer should show after a result message. The server
// reports the mode a turn actually ran in as `effective_mode` (additive
// field on speech_result/text_result); anything else — absent, non-string,
// empty, or absurdly long — falls back to the mode the request was sent with.
const MAX_MODE_LENGTH = 64;

export function displayModeFor(msg, fallbackMode) {
  const m = msg?.effective_mode;
  if (typeof m === "string" && m.length > 0 && m.length <= MAX_MODE_LENGTH) return m;
  return fallbackMode;
}

export const DEEP_THOUGHTFUL_MODE = "deep_thoughtful";

// Whether a transcript turn ran in deep_thoughtful, for the bubble indicator.
export function isDeepThoughtful(turn) {
  return turn?.mode === DEEP_THOUGHTFUL_MODE && !turn.is_filler;
}
