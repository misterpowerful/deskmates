import test from "node:test";
import assert from "node:assert/strict";
import {
  responseSafetyTimeoutMs,
  recordReplyLatency,
  resetObservedLatencyForTests,
  FAST_MODE_TIMEOUT_MS,
  DEEP_THOUGHTFUL_BASE_TIMEOUT_MS,
  DEEP_THOUGHTFUL_MAX_TIMEOUT_MS,
} from "../../webapp/src/composables/replyWaitPolicy.js";

test.beforeEach(() => resetObservedLatencyForTests());

test("malformed/hostile mode values fail safe to the fast-path timeout", () => {
  for (const mode of [null, undefined, "", 42, {}, [], "deep_thoughtful ", "DEEP_THOUGHTFUL", "x".repeat(10000)]) {
    assert.equal(responseSafetyTimeoutMs(mode), FAST_MODE_TIMEOUT_MS, `mode=${JSON.stringify(mode)}`);
  }
});

test("recordReplyLatency ignores non-finite/negative/zero readings instead of corrupting the adaptive floor", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, "33000", null, undefined, {}, []]) {
    recordReplyLatency("deep_thoughtful", bad);
  }
  // No legitimate reading was ever recorded, so the timeout must still be
  // exactly the base floor — not NaN, not corrupted, not inflated.
  assert.equal(responseSafetyTimeoutMs("deep_thoughtful"), DEEP_THOUGHTFUL_BASE_TIMEOUT_MS);
});

test("recordReplyLatency ignores readings for a hostile/malformed mode", () => {
  for (const mode of [null, undefined, "", "Deep_Thoughtful", 42]) {
    recordReplyLatency(mode, 60000);
  }
  assert.equal(responseSafetyTimeoutMs("deep_thoughtful"), DEEP_THOUGHTFUL_BASE_TIMEOUT_MS);
});

test("an absurdly oversized observed latency is clamped, not left to grow the wait unbounded", () => {
  recordReplyLatency("deep_thoughtful", Number.MAX_SAFE_INTEGER);
  const timeout = responseSafetyTimeoutMs("deep_thoughtful");
  assert.equal(timeout, DEEP_THOUGHTFUL_MAX_TIMEOUT_MS);
  assert.ok(Number.isFinite(timeout));
});

test("a single hostile NaN/Infinity call sandwiched between good readings doesn't erase the good ones", () => {
  recordReplyLatency("deep_thoughtful", 25000);
  recordReplyLatency("deep_thoughtful", NaN);
  recordReplyLatency("deep_thoughtful", Infinity);
  const timeout = responseSafetyTimeoutMs("deep_thoughtful");
  assert.ok(Number.isFinite(timeout));
  assert.ok(timeout >= DEEP_THOUGHTFUL_BASE_TIMEOUT_MS);
});
