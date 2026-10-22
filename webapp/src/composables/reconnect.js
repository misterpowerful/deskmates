// Pure decision logic for session.js's auto-reconnect behavior, split out
// so it's testable without a browser (session.js itself touches
// localStorage/WebSocket/crypto at import time, which node:test can't
// provide). Mirrors the shape of src/retry.js's withRetry/isTransientError
// split: session.js owns the WebSocket/timer plumbing, this module owns the
// "should we retry, and how long do we wait" math.

// The exact code + reason disconnect() closes with on a deliberate,
// user-initiated disconnect. Any other close (server restart, dropped wifi,
// tab suspend, etc.) is unexpected and should trigger a reconnect.
export const MANUAL_DISCONNECT_CODE = 1000;
export const MANUAL_DISCONNECT_REASON = "manual disconnect";

export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 16000;

// event is whatever the WebSocket 'close' listener receives — a real
// CloseEvent in the browser, or a plain {code, reason} object in tests.
// Treated as unexpected (reconnect) unless it exactly matches the sentinel
// disconnect() itself closes with.
export function isUnexpectedClose(event) {
  const code = event?.code;
  const reason = event?.reason;
  return !(code === MANUAL_DISCONNECT_CODE && reason === MANUAL_DISCONNECT_REASON);
}

// Capped exponential backoff: 1s, 2s, 4s, 8s, 16s, 16s, 16s, ... — attempt
// is 1-based (the first retry after a drop is attempt 1). Never gives up;
// the cap just stops the delay from growing further, it doesn't stop
// retrying.
export function nextReconnectDelay(attempt, { baseMs = RECONNECT_BASE_DELAY_MS, maxMs = RECONNECT_MAX_DELAY_MS } = {}) {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const delay = baseMs * 2 ** (n - 1);
  return Math.min(delay, maxMs);
}
