import { DEEP_THOUGHTFUL_MODE } from "./effectiveMode.js";

// How long the client-side VAD loop (useAutoConversation.js) waits for a
// turn's reply audio before giving up and resuming listening — see
// armResponseSafetyTimer() there. Split out from a single fixed constant
// because deep_thoughtful (Sonnet) and the fast-path modes (friendly,
// sentry_intruder, bump_complaint — all Haiku) have wildly different
// realistic response times; one timeout tuned for the fast path was giving
// up on deep_thoughtful turns mid-generation. Live session logs
// (2026-09-22) showed deep_thoughtful replies landing 15-35s after the
// request, well past the old fixed 20s safety net — the client would log
// "no reply audio arrived in time" and bounce the visualizer back to
// "listening" (misleadingly, since it's the user's cue that the bot is done
// and ready for new input) while the server was still composing/synthesizing
// the actual reply, which then arrived into a turn the client had already
// moved past.

// Fast-path modes: unchanged from the original fixed safety net. These
// reliably land in 2-4s, so 20s is already generous headroom for a genuine
// pipeline failure with no fallback audio at all.
export const FAST_MODE_TIMEOUT_MS = 20000;

// deep_thoughtful's floor: comfortably above the 15-35s observed in live
// logs (and the ~40s acceptance bound), so a normal deep_thoughtful turn
// never trips the safety net.
export const DEEP_THOUGHTFUL_BASE_TIMEOUT_MS = 45000;

// Once a deep_thoughtful turn is actually observed running past the base
// floor, later turns this session get padded above the slowest one seen —
// reflects real observed latency instead of a fixed guess. Only ever grows
// within a session (a single fast reply doesn't mean the next one will be
// too); resets on page reload along with all other module state here.
const DEEP_THOUGHTFUL_LATENCY_PADDING_MS = 10000;

// Absolute ceiling regardless of what's been observed, so a corrupted or
// hostile latency reading (see recordReplyLatency) can't push the safety
// net out indefinitely — it still needs to exist as a last-resort recovery
// from a genuinely dead pipeline.
export const DEEP_THOUGHTFUL_MAX_TIMEOUT_MS = 120000;

let observedMaxLatencyMs = 0;

// The duration to arm the response-safety timer with for a turn expected to
// run in `mode`. `mode` should be the last known effective mode (sticky
// server-side once deep_thoughtful triggers, so the mode of the *previous*
// turn is a reliable predictor of this one) rather than the mode value the
// request itself was sent with, which this client always sends as
// "friendly" — see DEFAULT_MODE in session.js.
export function responseSafetyTimeoutMs(mode) {
  if (mode !== DEEP_THOUGHTFUL_MODE) return FAST_MODE_TIMEOUT_MS;
  const adaptive = observedMaxLatencyMs + DEEP_THOUGHTFUL_LATENCY_PADDING_MS;
  const wanted = Math.max(DEEP_THOUGHTFUL_BASE_TIMEOUT_MS, adaptive);
  return Math.min(wanted, DEEP_THOUGHTFUL_MAX_TIMEOUT_MS);
}

// Feeds an actually-observed reply latency back into the adaptive floor
// above. Only deep_thoughtful turns move the needle — fast-path latencies
// are irrelevant to a timeout that's already fixed for them. Silently
// ignores anything that isn't a genuine positive, finite measurement (a
// negative/NaN/Infinity reading would otherwise poison every future
// Math.max comparison with NaN, or inflate the timeout without bound).
export function recordReplyLatency(mode, elapsedMs) {
  if (mode !== DEEP_THOUGHTFUL_MODE) return;
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  if (elapsedMs > observedMaxLatencyMs) observedMaxLatencyMs = elapsedMs;
}

// Test-only: module state above is otherwise session-lifetime (by design —
// see DEEP_THOUGHTFUL_LATENCY_PADDING_MS), so suites need a way to isolate
// themselves from each other's recordings.
export function resetObservedLatencyForTests() {
  observedMaxLatencyMs = 0;
}
