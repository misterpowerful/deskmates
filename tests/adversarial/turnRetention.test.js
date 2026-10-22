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

test("rejects invalid day counts rather than deleting everything", () => {
  for (const days of [0, -5, NaN, Infinity, "90", null, undefined]) {
    assert.throws(() => pruneOldTurns({ days, dir: tmp() }), /positive number/);
  }
  assert.throws(() => pruneOldTurns(), /positive number/);
});

test("malformed config falls back to default", () => {
  for (const v of [0, -1, "30", NaN, null, {}, Infinity]) {
    assert.equal(resolveRetentionDays({ turn_log_retention_days: v }), DEFAULT_RETENTION_DAYS);
  }
  assert.equal(resolveRetentionDays(null), DEFAULT_RETENTION_DAYS);
});

test("jsonl: undatable, corrupt and blank lines are kept, not dropped", () => {
  const dir = tmp();
  const p = path.join(dir, "turns.jsonl");
  const old = JSON.stringify({ ts: "2000-01-01T00:00:00.000Z" });
  fs.writeFileSync(p, `${old}\nnot json\n\n{"no":"ts"}\n{"ts":5}\nnull\n`);
  const res = pruneOldTurns({ days: 1, dir });
  assert.equal(res.deleted, 1);
  assert.deepEqual(fs.readFileSync(p, "utf8").trim().split("\n"), ["not json", '{"no":"ts"}', '{"ts":5}', "null"]);
});

test("jsonl: everything old leaves an empty file", () => {
  const dir = tmp();
  const p = path.join(dir, "turns.jsonl");
  fs.writeFileSync(p, JSON.stringify({ ts: "2000-01-01T00:00:00.000Z" }) + "\n");
  assert.equal(pruneOldTurns({ days: 1, dir }).deleted, 1);
  assert.equal(fs.readFileSync(p, "utf8"), "");
});

test("sqlite: pre-migration db without rate_limit_events table prunes turns without crashing", () => {
  const dir = tmp();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "turns.db"));
  db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, transcript TEXT)");
  db.prepare("INSERT INTO turns (ts, transcript) VALUES (?, ?)").run(daysAgo(200), "old");
  db.close();
  const res = pruneOldTurns({ days: 90, dir });
  assert.equal(res.deleted, 1);
});

test("sqlite: rate_limit_events row just inside the retention window is kept, not deleted", () => {
  const dir = tmp();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "turns.db"));
  db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, transcript TEXT)");
  db.exec(
    "CREATE TABLE rate_limit_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, call_id TEXT, rate_limit_type TEXT, utilization REAL, resets_at INTEGER, status TEXT)",
  );
  db.prepare("INSERT INTO rate_limit_events (ts, call_id) VALUES (?, ?)").run(daysAgo(89), "boundary");
  db.close();
  const res = pruneOldTurns({ days: 90, dir });
  assert.equal(res.deleted, 0);
  const check = new DatabaseSync(path.join(dir, "turns.db"));
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM rate_limit_events").get().n, 1);
  check.close();
});
