import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getConversationHistory, DEFAULT_HISTORY_LIMIT } from "../../src/conversationHistory.js";

const require = createRequire(import.meta.url);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));

function makeDb(dir, rows) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "turns.db"));
  db.exec(
    "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session_id TEXT, transcript TEXT, reply TEXT)",
  );
  const ins = db.prepare("INSERT INTO turns (ts, session_id, transcript, reply) VALUES (?, ?, ?, ?)");
  for (const r of rows) ins.run(r.ts, r.sessionId ?? null, r.transcript ?? null, r.reply ?? null);
  db.close();
}

test("no turns.db yet returns an empty conversation, not an error", () => {
  const dir = tmp();
  assert.deepEqual(getConversationHistory({ sessionId: "abc", dir }), { sessionId: "abc", turns: [] });
});

test("returns only this session's turns, oldest first, split into user/assistant bubbles", () => {
  const dir = tmp();
  makeDb(dir, [
    { ts: "2026-01-01T00:00:03.000Z", sessionId: "s1", transcript: "third", reply: "third reply" },
    { ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "first", reply: "first reply" },
    { ts: "2026-01-01T00:00:02.000Z", sessionId: "other-session", transcript: "not mine", reply: "not mine reply" },
    { ts: "2026-01-01T00:00:02.500Z", sessionId: "s1", transcript: "second", reply: "second reply" },
  ]);
  const { sessionId, turns } = getConversationHistory({ sessionId: "s1", dir });
  assert.equal(sessionId, "s1");
  assert.deepEqual(
    turns.map((t) => t.text),
    ["first", "first reply", "second", "second reply", "third", "third reply"],
  );
  assert.deepEqual(turns.map((t) => t.role), [
    "user", "assistant", "user", "assistant", "user", "assistant",
  ]);
});

test("a failed turn with no reply contributes only its user bubble", () => {
  const dir = tmp();
  makeDb(dir, [{ ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "hello", reply: null }]);
  const { turns } = getConversationHistory({ sessionId: "s1", dir });
  assert.deepEqual(turns, [{ ts: "2026-01-01T00:00:01.000Z", role: "user", text: "hello" }]);
});

test("since restricts to rows at or after that instant, oldest-first within that window", () => {
  const dir = tmp();
  makeDb(dir, [
    { ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "yesterday" },
    { ts: "2026-01-02T00:00:00.000Z", sessionId: "s1", transcript: "exactly midnight" },
    { ts: "2026-01-02T08:00:00.000Z", sessionId: "s1", transcript: "today" },
  ]);
  const { turns } = getConversationHistory({ sessionId: "s1", dir, since: "2026-01-02T00:00:00.000Z" });
  assert.deepEqual(turns.map((t) => t.text), ["exactly midnight", "today"]);
});

test("omitting since preserves the old all-time-within-limit behavior", () => {
  const dir = tmp();
  makeDb(dir, [{ ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "old" }]);
  const { turns } = getConversationHistory({ sessionId: "s1", dir });
  assert.deepEqual(turns.map((t) => t.text), ["old"]);
});

test("default and explicit limit are honored, returning the most recent turns", () => {
  const dir = tmp();
  const rows = Array.from({ length: 5 }, (_, i) => ({
    ts: `2026-01-01T00:00:0${i}.000Z`,
    sessionId: "s1",
    transcript: `t${i}`,
  }));
  makeDb(dir, rows);
  assert.equal(getConversationHistory({ sessionId: "s1", dir }).turns.length, 5);
  assert.equal(DEFAULT_HISTORY_LIMIT >= 5, true);
  const limited = getConversationHistory({ sessionId: "s1", dir, limit: 2 });
  assert.deepEqual(limited.turns.map((t) => t.text), ["t3", "t4"]);
});
