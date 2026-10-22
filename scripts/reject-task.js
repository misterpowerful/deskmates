import path from "node:path";
import { parseArgs } from "node:util";
import { log } from "../src/logger.js";
import { rejectTask, RejectTaskError } from "../src/taskQueue.js";

// Moves a task into tasks/rejected/, optionally recording why. Works on a
// filename in EITHER tasks/proposed/ (an ideation idea awaiting approval)
// or tasks/pending/ (including a source: gatsby-conversation task written
// by the conversational self-improvement path in src/speechPipeline.js,
// which skips approve-task entirely and would otherwise be picked up by
// the next run-build-task.js cron with no human veto point). Checks
// proposed/ first, then pending/. run-ideation.js reads tasks/rejected/
// (and any reason appended here) so it doesn't re-suggest the same thing.
//
// Usage: npm run reject-task -- <filename> ["reason"]

const ROOT = process.cwd();

function fatal(message) {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function parseCliArgs() {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [filename, reason] = positionals;
  if (!filename) {
    fatal('Usage: npm run reject-task -- <filename> ["reason"]');
  }
  return { filename: path.basename(filename), reason };
}

function main() {
  const { filename, reason } = parseCliArgs();
  let result;
  try {
    result = rejectTask(ROOT, filename, reason);
  } catch (err) {
    if (err instanceof RejectTaskError) fatal(err.message);
    throw err;
  }
  log(`Rejected: tasks/${result.fromDir}/${filename} -> tasks/rejected/${filename}` + (reason ? ` (reason: ${reason})` : ""));
  log("Committed.");
}

main();
