// Retention for the per-run JSON (and occasional .patch) logs the overnight
// jobs write straight into logs/ on every run: scripts/run-build-task.js
// (self-build-*), run-ideation.js (self-ideation-*), run-cleanup.js
// (self-cleanup-*.json, plus a self-cleanup-*.patch for a discarded diff),
// run-reflection.js (self-reflection-*), and scripts/lib/gate.js's
// writeGateFailure (gate-failure-*). None of these ever got pruned, so they
// grow unbounded and — since only logs/turns.db*/turns.jsonl are gitignored —
// pile up as untracked noise in `git status` forever.
//
// Deliberately separate from src/turnLog.js's pruneOldTurns: these are plain
// files aged by mtime, not database rows aged by an embedded timestamp
// column, and a bug in one must not risk the other.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_JOB_LOG_RETENTION_DAYS = 30;

// Exact prefixes only (each includes the trailing "-") so e.g. self-cleanup-*
// matches its .json and .patch files but not the unrelated self-cleanup.lock
// sitting right next to them in logs/.
const JOB_LOG_PREFIXES = [
  "self-build-",
  "self-ideation-",
  "self-cleanup-",
  "self-reflection-",
  "gate-failure-",
];

function isJobLogFile(name) {
  return JOB_LOG_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// A missing/malformed config value falls back to the default rather than to
// "keep forever" or "delete everything".
export function resolveJobLogRetentionDays(config) {
  const d = config?.job_log_retention_days;
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : DEFAULT_JOB_LOG_RETENTION_DAYS;
}

// Deletes job-log files in `dir` older than `days` (by mtime) whose name
// starts with one of the known job-log prefixes. Everything else in the
// directory (turns.db*, turns.jsonl, cron.log, self-cleanup.lock, ...) is
// left untouched. Throws on an invalid `days`; a missing directory is a
// no-op rather than an error.
export function pruneOldJobLogs({ days, dir } = {}) {
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    throw new Error(`pruneOldJobLogs: days must be a positive number, got ${days}`);
  }
  const cutoffMs = Date.now() - days * 86400_000;
  const deletedFiles = [];

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }

  for (const name of entries) {
    if (!isJobLogFile(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue; // gone already (e.g. a concurrent run)
    }
    if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
    try {
      fs.unlinkSync(full);
      deletedFiles.push(name);
    } catch {
      // Best-effort: a file another process is mid-write on is left for the
      // next run rather than risking a partial/corrupt delete.
    }
  }

  return { days, cutoff: new Date(cutoffMs).toISOString(), deleted: deletedFiles.length, deletedFiles };
}
