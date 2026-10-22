import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pruneOldTurns, resolveRetentionDays, DEFAULT_RETENTION_DAYS } from "../../src/turnLog.js";

const require = createRequire(import.meta.url);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "turns-"));

test("resolveRetentionDays uses config value or default", () => {
  assert.equal(resolveRetentionDays({ turn_log_retention_days: 30 }), 30);
  assert.equal(resolveRetentionDays({}), DEFAULT_RETENTION_DAYS);
});

test("prunes old sqlite rows and keeps recent ones", () => {
  const dir = tmp();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "turns.db"));
  db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, transcript TEXT)");
  const ins = db.prepare("INSERT INTO turns (ts, transcript) VALUES (?, ?)");
  ins.run(daysAgo(200), "old");
  ins.run(daysAgo(91), "old2");
  ins.run(daysAgo(1), "new");
  db.close();
  const res = pruneOldTurns({ days: 90, dir });
  assert.equal(res.deleted, 2);
  const check = new DatabaseSync(path.join(dir, "turns.db"));
  assert.deepEqual(check.prepare("SELECT transcript FROM turns").all().map((r) => r.transcript), ["new"]);
  check.close();
});

test("prunes old rate_limit_events rows and keeps recent ones", () => {
  const dir = tmp();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "turns.db"));
  db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, transcript TEXT)");
  db.exec(
    "CREATE TABLE rate_limit_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, call_id TEXT, rate_limit_type TEXT, utilization REAL, resets_at INTEGER, status TEXT)",
  );
  const ins = db.prepare(
    "INSERT INTO rate_limit_events (ts, call_id, rate_limit_type, utilization) VALUES (?, ?, ?, ?)",
  );
  ins.run(daysAgo(200), "old-call", "session", 0.5);
  ins.run(daysAgo(91), "old-call-2", "session", 0.6);
  ins.run(daysAgo(1), "new-call", "session", 0.7);
  db.close();
  const res = pruneOldTurns({ days: 90, dir });
  assert.equal(res.deleted, 2);
  const check = new DatabaseSync(path.join(dir, "turns.db"));
  assert.deepEqual(
    check.prepare("SELECT call_id FROM rate_limit_events").all().map((r) => r.call_id),
    ["new-call"],
  );
  check.close();
});

test("prunes old jsonl lines", () => {
  const dir = tmp();
  const p = path.join(dir, "turns.jsonl");
  fs.writeFileSync(p, [{ ts: daysAgo(100), t: "a" }, { ts: daysAgo(2), t: "b" }].map((o) => JSON.stringify(o)).join("\n") + "\n");
  const res = pruneOldTurns({ days: 90, dir });
  assert.equal(res.deleted, 1);
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).t, "b");
});

test("empty directory is a no-op", () => {
  assert.equal(pruneOldTurns({ days: 90, dir: tmp() }).deleted, 0);
});
