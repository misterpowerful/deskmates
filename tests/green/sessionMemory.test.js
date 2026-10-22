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

test("connections with no session_id behave exactly as before: per-connection, isolated", () => {
  const a = {};
  const b = {};
  appendTurn(a, "user", "hi from a");
  appendTurn(b, "user", "hi from b");
  assert.deepEqual(getTurns(a), [{ role: "user", content: "hi from a" }]);
  assert.deepEqual(getTurns(b), [{ role: "user", content: "hi from b" }]);
  clearTurns(a);
  assert.deepEqual(getTurns(a), []);
  assert.deepEqual(getTurns(b), [{ role: "user", content: "hi from b" }]);
});

test("a reconnect carrying the same session_id resumes prior turns instead of starting empty", async () => {
  const sessionId = `resume-${Date.now()}-${Math.random()}`;
  const ws1 = { sessionId };
  resumeSession(ws1);
  appendTurn(ws1, "user", "what's the second one");
  appendTurn(ws1, "assistant", "the blue one");
  assert.equal(getTurns(ws1).length, 2);

  // Connection drops (wifi handoff) — memory is scheduled for eviction, not
  // wiped immediately.
  expireSession(ws1, 10_000);

  // Webapp auto-reconnects with a brand-new ws object but the same
  // session_id (persisted in localStorage).
  const ws2 = { sessionId };
  resumeSession(ws2);
  assert.deepEqual(getTurns(ws2), [
    { role: "user", content: "what's the second one" },
    { role: "assistant", content: "the blue one" },
  ]);

  // Continues the same conversation.
  appendTurn(ws2, "user", "make it shorter");
  assert.equal(getTurns(ws2).length, 3);
});

test("session memory is evicted once the grace window elapses without a reconnect", async () => {
  const sessionId = `expire-${Date.now()}-${Math.random()}`;
  const ws1 = { sessionId };
  resumeSession(ws1);
  appendTurn(ws1, "user", "hello");
  expireSession(ws1, 20);

  await wait(80);

  const ws2 = { sessionId };
  resumeSession(ws2);
  assert.deepEqual(getTurns(ws2), []);
});

test("reconnecting before the grace window elapses cancels the pending eviction", async () => {
  const sessionId = `cancel-${Date.now()}-${Math.random()}`;
  const ws1 = { sessionId };
  resumeSession(ws1);
  appendTurn(ws1, "user", "remember this");
  expireSession(ws1, 30);

  const ws2 = { sessionId };
  resumeSession(ws2); // reconnect races and wins before the 30ms elapses

  await wait(80); // long past the original grace window

  assert.deepEqual(getTurns(ws2), [{ role: "user", content: "remember this" }]);
});

test("clearTurns on a session-keyed connection (personality switch) empties memory for the next connection sharing that id", () => {
  const sessionId = `clear-${Date.now()}-${Math.random()}`;
  const ws1 = { sessionId };
  resumeSession(ws1);
  appendTurn(ws1, "user", "before switch");
  clearTurns(ws1);
  assert.deepEqual(getTurns(ws1), []);

  const ws2 = { sessionId };
  resumeSession(ws2);
  assert.deepEqual(getTurns(ws2), []);
});

test("session-keyed memory respects the configured max-turns trim, same as the no-session-id path", () => {
  const sessionId = `trim-${Date.now()}-${Math.random()}`;
  const ws = { sessionId };
  resumeSession(ws);
  for (let i = 0; i < 25; i++) appendTurn(ws, "user", `turn ${i}`);
  const turns = getTurns(ws);
  assert.equal(turns.length, 20);
  assert.equal(turns[0].content, "turn 5");
  assert.equal(turns[19].content, "turn 24");
});
