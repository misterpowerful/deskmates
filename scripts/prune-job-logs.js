// Deletes per-run job-log files (self-build-*, self-ideation-*,
// self-cleanup-*, self-reflection-*, gate-failure-*) older than
// config.json's job_log_retention_days (default 30). Logic lives in
// src/jobLogs.js. See scripts/prune-turns.js for the equivalent job covering
// logs/turns.db.
//
// Cron:  15 4 * * * cd /var/www/deskmates && node scripts/prune-job-logs.js >> logs/cron.log 2>&1

import path from "node:path";
import { readConfig } from "../src/config.js";
import { log, logError } from "../src/logger.js";
import { pruneOldJobLogs, resolveJobLogRetentionDays } from "../src/jobLogs.js";

try {
  const days = resolveJobLogRetentionDays(readConfig());
  const dir = path.join(process.cwd(), "logs");
  const { cutoff, deleted } = pruneOldJobLogs({ days, dir });
  log("prune-job-logs: done", { days, cutoff, deleted });
} catch (err) {
  logError("prune-job-logs: failed", { error: err?.message ?? String(err) });
  process.exit(1);
}
