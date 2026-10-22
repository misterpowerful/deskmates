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

test("nextReconnectDelay doubles from the base delay and caps at the max", () => {
  assert.equal(nextReconnectDelay(1), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(2), 2000);
  assert.equal(nextReconnectDelay(3), 4000);
  assert.equal(nextReconnectDelay(4), 8000);
  assert.equal(nextReconnectDelay(5), RECONNECT_MAX_DELAY_MS); // 16000, exactly the cap
  assert.equal(nextReconnectDelay(6), RECONNECT_MAX_DELAY_MS); // still capped, not abandoned
  assert.equal(nextReconnectDelay(20), RECONNECT_MAX_DELAY_MS); // keeps retrying indefinitely
});

test("nextReconnectDelay honors custom base/max overrides", () => {
  assert.equal(nextReconnectDelay(1, { baseMs: 500, maxMs: 2000 }), 500);
  assert.equal(nextReconnectDelay(2, { baseMs: 500, maxMs: 2000 }), 1000);
  assert.equal(nextReconnectDelay(3, { baseMs: 500, maxMs: 2000 }), 2000);
  assert.equal(nextReconnectDelay(4, { baseMs: 500, maxMs: 2000 }), 2000);
});

test("isUnexpectedClose is false only for the exact manual-disconnect sentinel", () => {
  assert.equal(
    isUnexpectedClose({ code: MANUAL_DISCONNECT_CODE, reason: MANUAL_DISCONNECT_REASON }),
    false,
  );
});

test("isUnexpectedClose is true for a normal server-restart close", () => {
  // server.js's shutdown() closes connections; browsers commonly report
  // 1001 (going away) or 1006 (abnormal) for that.
  assert.equal(isUnexpectedClose({ code: 1001, reason: "" }), true);
  assert.equal(isUnexpectedClose({ code: 1006, reason: "" }), true);
});

test("isUnexpectedClose is true when code matches but reason doesn't (and vice versa)", () => {
  assert.equal(isUnexpectedClose({ code: MANUAL_DISCONNECT_CODE, reason: "server restart" }), true);
  assert.equal(isUnexpectedClose({ code: 1001, reason: MANUAL_DISCONNECT_REASON }), true);
});
