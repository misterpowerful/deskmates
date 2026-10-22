import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { log } from "../src/logger.js";
import { validateTaskFile } from "../src/dataValidation.js";

// Moves a self-proposed idea from tasks/proposed/ into tasks/pending/,
// making it buildable by scripts/run-build-task.js. Human-written tasks
// never need this — they're dropped straight into tasks/pending/.
//
// Usage: npm run approve-task -- <filename>

const ROOT = process.cwd();
const PROPOSED_DIR = path.join(ROOT, "tasks", "proposed");
const PENDING_DIR = path.join(ROOT, "tasks", "pending");

function fatal(message) {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function parseCliArgs() {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [filename] = positionals;
  if (!filename) {
    fatal("Usage: npm run approve-task -- <filename>");
  }
  return path.basename(filename); // no path traversal via ../
}

function git(args) {
  execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
}

function main() {
  const filename = parseCliArgs();
  const srcPath = path.join(PROPOSED_DIR, filename);
  const destPath = path.join(PENDING_DIR, filename);

  if (!fs.existsSync(srcPath)) {
    fatal(`No such proposed task: tasks/proposed/${filename}`);
  }
  if (fs.existsSync(destPath)) {
    fatal(`A task already exists at tasks/pending/${filename}`);
  }

  const check = validateTaskFile(fs.readFileSync(srcPath, "utf8"));
  if (!check.ok) {
    fatal(`Refusing to approve invalid task file: ${check.errors.join("; ")}`);
  }

  fs.renameSync(srcPath, destPath);
  log(`Approved: tasks/proposed/${filename} -> tasks/pending/${filename}`);

  git(["add", "-A", "--", "tasks/proposed", "tasks/pending"]);
  git(["commit", "-m", `Approve task: ${filename}`]);
  log("Committed.");
}

main();
