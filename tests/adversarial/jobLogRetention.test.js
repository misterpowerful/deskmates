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

test("rejects invalid day counts rather than deleting everything", () => {
  for (const days of [0, -5, NaN, Infinity, "30", null, undefined]) {
    assert.throws(() => pruneOldJobLogs({ days, dir: tmp() }), /positive number/);
  }
  assert.throws(() => pruneOldJobLogs(), /positive number/);
});

test("malformed config falls back to default", () => {
  for (const v of [0, -1, "30", NaN, null, {}, Infinity]) {
    assert.equal(resolveJobLogRetentionDays({ job_log_retention_days: v }), DEFAULT_JOB_LOG_RETENTION_DAYS);
  }
  assert.equal(resolveJobLogRetentionDays(null), DEFAULT_JOB_LOG_RETENTION_DAYS);
});

test("missing directory is a no-op, not a crash", () => {
  const res = pruneOldJobLogs({ days: 30, dir: path.join(os.tmpdir(), "does-not-exist-" + Date.now()) });
  assert.equal(res.deleted, 0);
  assert.deepEqual(res.deletedFiles, []);
});

test("similarly-named but unrelated files are never touched", () => {
  const dir = tmp();
  // "self-cleanup.lock" (dot, not the "-" every real job-log name has right
  // after the prefix) must not be swept up just because it starts with
  // "self-cleanup".
  writeAged(dir, "self-cleanup.lock", 90);
  // Not one of the five known prefixes at all.
  writeAged(dir, "generation-sardonic-sophisticate-2026-08-01T00-00-00-000Z.json", 90);
  writeAged(dir, "self-buildup-2026-08-01T00-00-00-000Z.json", 90);

  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.deleted, 0);
  assert.equal(fs.readdirSync(dir).length, 3);
});

test("a file just inside the retention window is kept, not deleted", () => {
  const dir = tmp();
  writeAged(dir, "self-build-boundary.json", 29);
  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.deleted, 0);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("a broken symlink (vanished between readdir and stat) is skipped without crashing", () => {
  const dir = tmp();
  const link = path.join(dir, "self-build-broken-link.json");
  fs.symlinkSync(path.join(dir, "does-not-exist.json"), link);
  assert.doesNotThrow(() => pruneOldJobLogs({ days: 30, dir }));
  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.deleted, 0);
  assert.ok(fs.lstatSync(link).isSymbolicLink()); // left in place, not deleted or crashed on
});

test("a subdirectory sharing a job-log prefix is skipped, not deleted", () => {
  const dir = tmp();
  const sub = path.join(dir, "self-build-not-a-file");
  fs.mkdirSync(sub);
  const old = new Date(Date.now() - 90 * 86400_000);
  fs.utimesSync(sub, old, old);
  const res = pruneOldJobLogs({ days: 30, dir });
  assert.equal(res.deleted, 0);
  assert.ok(fs.existsSync(sub));
});
