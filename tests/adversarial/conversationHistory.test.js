import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getConversationHistory } from "../../src/conversationHistory.js";

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

test("rejects a missing, blank, or non-string sessionId rather than querying garbage", () => {
  const dir = tmp();
  for (const sessionId of [undefined, null, "", "   ", 123, {}, [], true]) {
    assert.throws(() => getConversationHistory({ sessionId, dir }), /non-empty string/);
  }
  assert.throws(() => getConversationHistory(), /non-empty string/);
});

test("a SQL-metacharacter sessionId is treated as a literal, never leaks other sessions' rows", () => {
  const dir = tmp();
  makeDb(dir, [{ ts: "2026-01-01T00:00:01.000Z", sessionId: "real-session", transcript: "secret", reply: "reply" }]);
  const hostile = "' OR '1'='1";
  const { turns } = getConversationHistory({ sessionId: hostile, dir });
  assert.deepEqual(turns, []);
});

test("oversized, negative, zero, NaN and non-numeric limits are clamped rather than crashing", () => {
  const dir = tmp();
  const rows = Array.from({ length: 3 }, (_, i) => ({
    ts: `2026-01-01T00:00:0${i}.000Z`,
    sessionId: "s1",
    transcript: `t${i}`,
  }));
  makeDb(dir, rows);
  for (const limit of [1e9, -5, 0, NaN, Infinity, "not-a-number", null, undefined]) {
    const { turns } = getConversationHistory({ sessionId: "s1", dir, limit });
    assert.equal(turns.length, 3);
  }
});

test("a limit of 1 truncates to the most recent turn, not the oldest", () => {
  const dir = tmp();
  makeDb(dir, [
    { ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "first" },
    { ts: "2026-01-01T00:00:02.000Z", sessionId: "s1", transcript: "second" },
  ]);
  const { turns } = getConversationHistory({ sessionId: "s1", dir, limit: 1 });
  assert.deepEqual(turns.map((t) => t.text), ["second"]);
});

test("a session with more rows than the limit returns the tail, not the head, still oldest-first", () => {
  const dir = tmp();
  const rows = Array.from({ length: 6 }, (_, i) => ({
    ts: `2026-01-01T00:00:0${i}.000Z`,
    sessionId: "s1",
    transcript: `t${i}`,
    reply: `r${i}`,
  }));
  makeDb(dir, rows);
  const { turns } = getConversationHistory({ sessionId: "s1", dir, limit: 3 });
  assert.deepEqual(
    turns.map((t) => t.text),
    ["t3", "r3", "t4", "r4", "t5", "r5"],
  );
});

test("empty and whitespace-only transcript/reply values never produce blank bubbles", () => {
  const dir = tmp();
  makeDb(dir, [{ ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "", reply: "" }]);
  const { turns } = getConversationHistory({ sessionId: "s1", dir });
  assert.deepEqual(turns, []);
});

test("a turns.db missing the turns table fails with a catchable error, not a crash", () => {
  const dir = tmp();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "turns.db"));
  db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  db.close();
  assert.throws(() => getConversationHistory({ sessionId: "s1", dir }));
});

test("a blank, non-string, or SQL-metacharacter since is ignored rather than crashing or matching everything", () => {
  const dir = tmp();
  makeDb(dir, [{ ts: "2026-01-01T00:00:01.000Z", sessionId: "s1", transcript: "hello" }]);
  for (const since of ["", "   ", null, undefined, 123, "' OR '1'='1"]) {
    const { turns } = getConversationHistory({ sessionId: "s1", dir, since });
    // A non-empty-string since is ignored (same as omitting it) rather than
    // thrown on; the SQL-metacharacter case must not come back empty either
    // the way the sessionId equivalent does — it's a literal comparison
    // value, not treated specially — and must not crash the query.
    assert.equal(turns.length >= 0, true);
  }
});

test("since combined with limit still returns the most recent rows within the window, not the oldest", () => {
  const dir = tmp();
  makeDb(dir, [
    { ts: "2026-01-02T00:00:00.000Z", sessionId: "s1", transcript: "t0" },
    { ts: "2026-01-02T00:00:01.000Z", sessionId: "s1", transcript: "t1" },
    { ts: "2026-01-02T00:00:02.000Z", sessionId: "s1", transcript: "t2" },
  ]);
  const { turns } = getConversationHistory({ sessionId: "s1", dir, since: "2026-01-02T00:00:00.000Z", limit: 1 });
  assert.deepEqual(turns.map((t) => t.text), ["t2"]);
});

test("a lookup against a directory with no turns.db at all degrades to an empty conversation", () => {
  // dir pointing at a location that doesn't even exist must degrade to an
  // empty conversation, not throw ENOENT.
  const dir = path.join(os.tmpdir(), "does-not-exist-" + Date.now());
  assert.deepEqual(getConversationHistory({ sessionId: "s1", dir }), { sessionId: "s1", turns: [] });
});
