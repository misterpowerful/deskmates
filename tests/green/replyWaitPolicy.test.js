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

test("fast-path modes keep the original fixed timeout, unaffected by this change", () => {
  assert.equal(responseSafetyTimeoutMs("friendly"), FAST_MODE_TIMEOUT_MS);
  assert.equal(responseSafetyTimeoutMs("sentry_intruder"), FAST_MODE_TIMEOUT_MS);
  assert.equal(responseSafetyTimeoutMs("bump_complaint"), FAST_MODE_TIMEOUT_MS);
  assert.equal(FAST_MODE_TIMEOUT_MS, 20000);
});

test("deep_thoughtful gets a generously longer base timeout that covers the observed 15-35s range", () => {
  const timeout = responseSafetyTimeoutMs("deep_thoughtful");
  assert.equal(timeout, DEEP_THOUGHTFUL_BASE_TIMEOUT_MS);
  // Acceptance criteria: a turn taking up to ~40s must not trip the safety net.
  assert.ok(timeout > 40000, "base deep_thoughtful timeout must clear the 40s acceptance bound");
});

test("an observed slow deep_thoughtful reply pads the timeout for later turns this session", () => {
  recordReplyLatency("deep_thoughtful", 33000);
  const timeout = responseSafetyTimeoutMs("deep_thoughtful");
  assert.ok(timeout > 33000, "timeout must stay ahead of the slowest turn actually observed");
  assert.ok(timeout <= DEEP_THOUGHTFUL_MAX_TIMEOUT_MS);
});

test("the adaptive floor only grows within a session — a later fast reply doesn't shrink it", () => {
  recordReplyLatency("deep_thoughtful", 33000);
  const afterSlow = responseSafetyTimeoutMs("deep_thoughtful");
  recordReplyLatency("deep_thoughtful", 5000);
  assert.equal(responseSafetyTimeoutMs("deep_thoughtful"), afterSlow);
});

test("latency recorded against a fast-path mode never influences the deep_thoughtful timeout", () => {
  recordReplyLatency("friendly", 999999);
  assert.equal(responseSafetyTimeoutMs("deep_thoughtful"), DEEP_THOUGHTFUL_BASE_TIMEOUT_MS);
});

test("fast-path timeout is never changed by anything recorded for deep_thoughtful", () => {
  recordReplyLatency("deep_thoughtful", 100000);
  assert.equal(responseSafetyTimeoutMs("friendly"), FAST_MODE_TIMEOUT_MS);
});
