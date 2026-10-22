// Deletes turn-log rows older than config.json's turn_log_retention_days
// (default 90) and reclaims the disk space. Logic lives in src/turnLog.js.
//
// Cron:  30 4 * * * cd /var/www/deskmates && node scripts/prune-turns.js >> logs/cron.log 2>&1

import { readConfig } from "../src/config.js";
import { log, logError } from "../src/logger.js";
import { pruneOldTurns, resolveRetentionDays } from "../src/turnLog.js";

try {
  const days = resolveRetentionDays(readConfig());
  const { cutoff, deleted } = pruneOldTurns({ days });
  log("prune-turns: done", { days, cutoff, deleted });
} catch (err) {
  logError("prune-turns: failed", { error: err?.message ?? String(err) });
  process.exit(1);
}
