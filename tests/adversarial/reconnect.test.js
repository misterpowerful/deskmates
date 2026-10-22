import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUnexpectedClose,
  nextReconnectDelay,
  MANUAL_DISCONNECT_CODE,
  MANUAL_DISCONNECT_REASON,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "../../webapp/src/composables/reconnect.js";

test("nextReconnectDelay falls back to the first-attempt delay for non-positive/non-finite attempts", () => {
  assert.equal(nextReconnectDelay(0), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(-5), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(NaN), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(Infinity), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(-Infinity), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(undefined), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(null), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay("3"), RECONNECT_BASE_DELAY_MS); // no implicit string coercion
});

test("nextReconnectDelay never exceeds the cap even for an enormous attempt count", () => {
  assert.equal(nextReconnectDelay(Number.MAX_SAFE_INTEGER), RECONNECT_MAX_DELAY_MS);
  assert.equal(nextReconnectDelay(1000), RECONNECT_MAX_DELAY_MS);
});

test("nextReconnectDelay floors fractional attempts instead of throwing", () => {
  assert.equal(nextReconnectDelay(1.9), RECONNECT_BASE_DELAY_MS); // floors to attempt 1
  assert.equal(nextReconnectDelay(2.1), 2000); // floors to attempt 2
});

test("isUnexpectedClose treats a missing/null/empty close event as unexpected (never silently gives up)", () => {
  assert.equal(isUnexpectedClose(undefined), true);
  assert.equal(isUnexpectedClose(null), true);
  assert.equal(isUnexpectedClose({}), true);
});

test("isUnexpectedClose is not fooled by a code that's merely coercible to the sentinel", () => {
  assert.equal(isUnexpectedClose({ code: "1000", reason: MANUAL_DISCONNECT_REASON }), true);
  assert.equal(isUnexpectedClose({ code: MANUAL_DISCONNECT_CODE, reason: "Manual Disconnect" }), true);
  assert.equal(isUnexpectedClose({ code: MANUAL_DISCONNECT_CODE, reason: `${MANUAL_DISCONNECT_REASON} ` }), true);
  assert.equal(isUnexpectedClose({ code: 1000.0, reason: MANUAL_DISCONNECT_REASON, extra: "junk" }), false);
});

test("isUnexpectedClose ignores unexpected shapes on the event without throwing", () => {
  assert.doesNotThrow(() => isUnexpectedClose("not an event"));
  assert.doesNotThrow(() => isUnexpectedClose(42));
  assert.doesNotThrow(() => isUnexpectedClose([]));
  assert.equal(isUnexpectedClose("not an event"), true);
});
