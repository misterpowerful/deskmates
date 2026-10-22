import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneOldJobLogs, resolveJobLogRetentionDays, DEFAULT_JOB_LOG_RETENTION_DAYS } from "../../src/jobLogs.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "job-logs-"));

function writeAged(dir, name, daysAgo) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, "{}");
  const mtime = new Date(Date.now() - daysAgo * 86400_000);
  fs.utimesSync(full, mtime, mtime);
}

test("resolveJobLogRetentionDays uses config value or default", () => {
  assert.equal(resolveJobLogRetentionDays({ job_log_retention_days: 14 }), 14);
  assert.equal(resolveJobLogRetentionDays({}), DEFAULT_JOB_LOG_RETENTION_DAYS);
});

test("deletes job-log files older than the retention window, keeps recent ones", () => {
  const dir = tmp();
  writeAged(dir, "self-build-2026-08-01T00-00-00-000Z.json", 60);
  writeAged(dir, "self-ideation-2026-08-01T00-00-00-000Z.json", 45);
  writeAged(dir, "self-cleanup-2026-08-01T00-00-00-000Z.json", 40);
  writeAged(dir, "self-cleanup-2026-08-01T00-00-00-000Z.patch", 40);
  writeAged(dir, "self-reflection-2026-08-01T00-00-00-000Z.json", 40);
  writeAged(dir, "gate-failure-2026-08-01T00-00-00-000Z.json", 40);
  writeAged(dir, "self-build-2026-09-20T00-00-00-000Z.json", 2);

  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.deleted, 6);
  const remaining = fs.readdirSync(dir).sort();
  assert.deepEqual(remaining, ["self-build-2026-09-20T00-00-00-000Z.json"]);
});

test("leaves non-job-log files (turns.db, cron.log, self-cleanup.lock) untouched", () => {
  const dir = tmp();
  writeAged(dir, "self-build-old.json", 90);
  writeAged(dir, "turns.db", 90);
  writeAged(dir, "turns.jsonl", 90);
  writeAged(dir, "cron.log", 90);
  writeAged(dir, "self-cleanup.lock", 90);

  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.deleted, 1);
  const remaining = fs.readdirSync(dir).sort();
  assert.deepEqual(remaining, ["cron.log", "self-cleanup.lock", "turns.db", "turns.jsonl"]);
});

test("returns the resolved days and an ISO cutoff", () => {
  const dir = tmp();
  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.days, 30);
  assert.match(res.cutoff, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(res.deleted, 0);
  assert.deepEqual(res.deletedFiles, []);
});
