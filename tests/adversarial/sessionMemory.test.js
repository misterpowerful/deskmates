import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTurn,
  getTurns,
  clearTurns,
  resumeSession,
  expireSession,
} from "../../src/sessionMemory.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("an empty-string session_id (malformed query param) falls back to per-connection isolation instead of colliding", () => {
  const a = { sessionId: "" };
  const b = { sessionId: "" };
  appendTurn(a, "user", "a's secret");
  appendTurn(b, "user", "b's secret");
  assert.deepEqual(getTurns(a), [{ role: "user", content: "a's secret" }]);
  assert.deepEqual(getTurns(b), [{ role: "user", content: "b's secret" }]);
});

test("resumeSession/expireSession are no-ops that never throw for connections with no session_id", () => {
  for (const sessionId of [null, undefined, ""]) {
    assert.doesNotThrow(() => resumeSession({ sessionId }));
    assert.doesNotThrow(() => expireSession({ sessionId }));
  }
  assert.doesNotThrow(() => resumeSession({}));
  assert.doesNotThrow(() => expireSession({}));
});

test("expireSession on a session_id whose entry was never created (closed before any turn) does not throw or fabricate state", () => {
  const sessionId = `never-used-${Date.now()}-${Math.random()}`;
  assert.doesNotThrow(() => expireSession({ sessionId }, 10));
  const ws = { sessionId };
  resumeSession(ws);
  assert.deepEqual(getTurns(ws), []);
});

test("a rapid double-close (expireSession called twice) reschedules cleanly instead of throwing or double-firing", async () => {
  const sessionId = `double-close-${Date.now()}-${Math.random()}`;
  const ws = { sessionId };
  resumeSession(ws);
  appendTurn(ws, "user", "hi");
  expireSession(ws, 15);
  assert.doesNotThrow(() => expireSession(ws, 15));

  await wait(60);

  const ws2 = { sessionId };
  resumeSession(ws2);
  assert.deepEqual(getTurns(ws2), []);
});

test("getTurns/clearTurns on an unused session_id never crash and behave as empty", () => {
  const sessionId = `unused-${Date.now()}-${Math.random()}`;
  assert.deepEqual(getTurns({ sessionId }), []);
  assert.doesNotThrow(() => clearTurns({ sessionId }));
  assert.deepEqual(getTurns({ sessionId }), []);
});

test("non-string session_id values (defensive: real code always sends a string) don't crash the store", () => {
  for (const sessionId of [12345, { weird: "object" }, ["array"], true]) {
    const ws = { sessionId };
    assert.doesNotThrow(() => resumeSession(ws));
    assert.doesNotThrow(() => appendTurn(ws, "user", "hi"));
    assert.doesNotThrow(() => getTurns(ws));
    assert.doesNotThrow(() => clearTurns(ws));
    assert.doesNotThrow(() => expireSession(ws, 10));
  }
});

test("an oversized session_id string is usable as a key without crashing or truncating", () => {
  const sessionId = "s".repeat(200_000);
  const ws = { sessionId };
  resumeSession(ws);
  appendTurn(ws, "user", "hello from a huge session id");
  assert.deepEqual(getTurns(ws), [{ role: "user", content: "hello from a huge session id" }]);
  expireSession(ws, 10);
});

test("clearTurns on a session-keyed connection never falls back to mutating a same-shaped no-session-id connection", () => {
  const withId = { sessionId: `has-id-${Date.now()}-${Math.random()}` };
  const withoutId = { sessionId: null };
  appendTurn(withId, "user", "keep separate");
  appendTurn(withoutId, "user", "also keep separate");
  clearTurns(withId);
  assert.deepEqual(getTurns(withId), []);
  assert.deepEqual(getTurns(withoutId), [{ role: "user", content: "also keep separate" }]);
});
