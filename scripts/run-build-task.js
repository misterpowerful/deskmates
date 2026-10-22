import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { log } from "../src/logger.js";
import { appendNote } from "../src/taskFile.js";
import { listPendingInOrder } from "../src/queueOrder.js";
import { runFixLoop, describeGateOutcome, writeGateFailure, gateRulesForPrompt, stampPass, landMerge, landPush, checkRootOnMain, changedFilesSince } from "./lib/gate.js";
import { checkPersonalityChange, loadRecentTranscripts } from "./lib/personalityGuard.js";

// Cron runs with a bare PATH (/usr/bin:/bin) that doesn't include the
// claude CLI's install location, so a plain "claude" lookup fails with
// ENOENT there even though it resolves fine in an interactive shell.
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");

// Daily cron job: works through up to MAX_TASKS_PER_RUN (3) pending tasks per run, in queue order (manual drawer order, else oldest first). Creates an
// isolated git worktree, gives Claude Code full read/write access inside it
// (no off-limits files — the only safety net is the health-check rollback
// below), merges on success, restarts the live service, and rolls back to
// the pre-edit commit if the restart doesn't come up healthy. Never
// auto-retries a failure (and a failure doesn't stop the run); that's left
// for the owner to re-queue or investigate.
//
// Every change goes through the test gate (scripts/lib/gate.js, TESTING-GATE.md):
// green-path and adversarial suites, fed back to Claude until clean. A change
// that can't get clean (same failure in 3 rounds, or 8 rounds total) is
// discarded, never merged or pushed, and logged in logs/gate-failure-*.json.
//
// Usage: node scripts/run-build-task.js   (cron: 0 3 * * *)

const ROOT = process.cwd();
const DONE_DIR = path.join(ROOT, "tasks", "done");
const FAILED_DIR = path.join(ROOT, "tasks", "failed");
const LOGS_DIR = path.join(ROOT, "logs");
const PORT = Number(process.env.PORT) || 8080;

// Cap per run; the cron fires this script twice a night (midnight and 3am).
const MAX_TASKS_PER_RUN = Number(process.env.MAX_TASKS_PER_RUN) || 3;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;
const HEALTH_CHECK_ATTEMPTS = 6;
const HEALTH_CHECK_INTERVAL_MS = 5000;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitQuiet(args, cwd = ROOT) {
  try {
    return { ok: true, output: git(args, cwd) };
  } catch (err) {
    return { ok: false, output: err?.stdout ?? "", error: err?.message ?? String(err) };
  }
}

function writeLog(entry) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `self-build-${timestamp()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
  log(`Wrote build log to ${path.relative(ROOT, logPath)}`);
}

// Head of the queue: the user's manual order from the webapp drawer if set,
// oldest-first otherwise (src/queueOrder.js).
function pickNextPendingTask() {
  return listPendingInOrder(ROOT)[0];
}

function buildPrompt(task) {
  return `You are Deskmates's own automated build agent, working inside an isolated git worktree. Implement the following task, and keep the change scoped to exactly what it describes — this is a single, focused build pass, not an invitation to also refactor or "improve" unrelated things.

TASK TITLE: ${task.frontmatter.title ?? task.filename}

TASK DESCRIPTION:
${task.body}

Context: read CAPABILITIES.md at the repo root first — it's a living summary of what the bot can currently do, written in plain language for a "what can you do?" conversational answer. If this change adds or changes a user-facing capability, update CAPABILITIES.md to reflect it (concise, matching its existing style) as part of your change. If it doesn't change any capability, leave CAPABILITIES.md alone.

This repo is a Node.js WebSocket backend for a home robot ("Deskmates"/"Gatsby") — see README.md for a full overview if useful. You have full read/write access in this worktree; there is no off-limits file for the task itself. Do NOT touch anything under tasks/ — task lifecycle bookkeeping (moving this task file, logging outcomes) is handled by the orchestrating script outside this session, not by you.

Leave the working tree in a complete, working state. Do not run \`git commit\` yourself — the orchestrating script commits your change after you're done.

Personality and voice (personalities/*/personality-breakdown.md, voice-config.json): make the smallest change that addresses the request, and keep the character intact. Voice speed moves at most 0.1 per task and stays within 0.9-1.2. Such a change is only kept if the task quotes the owner's actual words asking for it; otherwise the orchestrating script discards it.

${gateRulesForPrompt()}`;
}

function invokeClaude(prompt, cwd, resumeSessionId) {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // Strip Anthropic credentials from the child environment. dotenv/config
  // (imported at the top of this file for the bot's own API keys) puts
  // ANTHROPIC_API_KEY into process.env, and Claude Code prefers an API key
  // over the logged-in subscription — so without this, every overnight build
  // session bills per-token to the API key instead of the Pro/Max plan.
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env;
  const stdout = execFileSync(CLAUDE_BIN, args, {
    cwd,
    env,
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function restartService() {
  execFileSync("sudo", ["systemctl", "restart", "deskmates.service"]);
}

function httpOk() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isServiceActive() {
  try {
    execFileSync("systemctl", ["is-active", "--quiet", "deskmates.service"]);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthy() {
  for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt++) {
    await sleep(HEALTH_CHECK_INTERVAL_MS);
    if (isServiceActive() && (await httpOk())) {
      return true;
    }
  }
  return false;
}

function moveTaskFile({ task, destDir, heading, note }) {
  const updatedRaw = appendNote(task.raw, heading, note);
  fs.writeFileSync(task.filePath, updatedRaw);
  const destPath = path.join(destDir, task.filename);
  fs.renameSync(task.filePath, destPath);
  return destPath;
}

async function processTask(task) {
  log(`run-build-task: picked up ${task.filename}`);

  const logEntry = {
    timestamp: new Date().toISOString(),
    task: task.filename,
    title: task.frontmatter.title ?? task.filename,
  };

  const preEditCommit = git(["rev-parse", "HEAD"]);
  logEntry.preEditCommit = preEditCommit;

  const ts = timestamp();
  const branch = `self-edit-${ts}`;
  const worktreePath = path.join(ROOT, "..", `deskmates-work-${ts}`);
  logEntry.branch = branch;
  logEntry.worktreePath = worktreePath;

  let worktreeCreated = false;
  let branchMerged = false;

  const fail = (reason) => {
    log(`run-build-task: FAILED — ${reason}`);
    logEntry.outcome = "failed";
    logEntry.failureReason = reason;

    if (branchMerged) {
      // The merge already landed on main — undo it before anything else.
      // The worktree/branch were already cleaned up right after the merge
      // succeeded (main flow, below), so there's nothing left to remove here.
      const reset = gitQuiet(["reset", "--hard", preEditCommit]);
      logEntry.rollback = reset;
      restartServiceBestEffort(logEntry);
    } else {
      // Failed before (or while) merging — main was never touched, just
      // clean up the worktree/branch this run created.
      cleanupWorktree(worktreePath, branch, worktreeCreated, branchMerged);
    }

    const destPath = moveTaskFile({
      task,
      destDir: FAILED_DIR,
      heading: "Failed",
      note: reason,
    });
    logEntry.movedTo = path.relative(ROOT, destPath);

    gitQuiet(["add", "-A", "--", "tasks/pending", "tasks/failed"]);
    gitQuiet(["commit", "-m", `Fail task: ${task.filename} — ${reason}`]);

    writeLog(logEntry);
    process.exitCode = 1;
  };

  // 0. ROOT must actually be on main before we fork a worktree from it and
  // later try to land the result there — see checkRootOnMain().
  const rootCheck = checkRootOnMain(ROOT);
  if (!rootCheck.ok) {
    fail(rootCheck.error);
    return;
  }

  // 1. Worktree off latest main.
  const worktreeResult = gitQuiet(["worktree", "add", "-b", branch, worktreePath, "main"]);
  if (!worktreeResult.ok) {
    fail(`could not create worktree: ${worktreeResult.error}`);
    return;
  }
  worktreeCreated = true;

  // Dependencies are gitignored, so give the worktree its own copy rather
  // than a symlink to the live node_modules: a symlink let an `npm ci` run
  // by the build session wipe the live install through it and take the
  // service down (see the ensureLiveDependencies safety net below).
  for (const dir of ["node_modules", path.join("webapp", "node_modules")]) {
    try {
      execFileSync("cp", ["-a", "--reflink=auto", path.join(ROOT, dir), path.join(worktreePath, dir)], {
        stdio: "ignore",
      });
    } catch (err) {
      log(`run-build-task: could not copy ${dir}, tests may not run`, { error: err?.message ?? String(err) });
    }
  }

  // 2. Invoke Claude Code inside the worktree.
  let claudeResult;
  try {
    claudeResult = invokeClaude(buildPrompt(task), worktreePath);
    logEntry.claude = {
      isError: claudeResult.is_error ?? false,
      numTurns: claudeResult.num_turns,
      durationMs: claudeResult.duration_ms,
      totalCostUsd: claudeResult.total_cost_usd,
      usage: claudeResult.usage,
      resultText: claudeResult.result,
    };
  } catch (err) {
    fail(`claude invocation failed: ${err?.message ?? String(err)}`);
    return;
  }

  const changed = gitQuiet(["status", "--porcelain"], worktreePath);
  if (!changed.ok || changed.output.trim() === "") {
    fail("claude made no changes to the worktree");
    return;
  }

  // 3. Test gate: green-path + adversarial suites, looping fixes back to
  // the same Claude session until clean or the oscillation/backstop limits hit.
  let sessionId = claudeResult.session_id;
  const loop = await runFixLoop({
    cwd: worktreePath,
    baseRef: "main",
    fix: async (prompt) => {
      const fixResult = invokeClaude(prompt, worktreePath, sessionId);
      sessionId = fixResult.session_id ?? sessionId;
    },
  });
  logEntry.gate = {
    outcome: loop.outcome,
    rounds: loop.rounds.map((r) => ({ round: r.round, passed: r.passed, failures: r.failures.length })),
  };
  if (loop.outcome !== "clean") {
    gitQuiet(["add", "-A"], worktreePath); // include new (untracked) files in the saved diff
    const diff = gitQuiet(["diff", "--cached", "HEAD"], worktreePath).output;
    const failureLog = writeGateFailure({
      root: ROOT,
      stamp: ts,
      job: "run-build-task",
      subject: task.filename,
      loop,
      diff,
    });
    logEntry.gateFailureLog = failureLog;
    fail(`${describeGateOutcome(loop)} (details: ${failureLog})`);
    return;
  }

  // 3b. Personality/voice guard (scripts/lib/personalityGuard.js): the owner's
  // real words behind it, and voice speed only in small steps.
  const guard = checkPersonalityChange({
    changedFiles: changedFilesSince(worktreePath, "main"),
    taskText: `${task.frontmatter.title ?? ""}\n${task.body}`,
    transcripts: loadRecentTranscripts(path.join(LOGS_DIR, "turns.db")),
    readBefore: (file) => gitQuiet(["show", `main:${file}`]).output ?? "",
    readAfter: (file) => (fs.existsSync(path.join(worktreePath, file)) ? fs.readFileSync(path.join(worktreePath, file), "utf8") : ""),
  });
  if (!guard.ok) {
    logEntry.personalityGuard = guard.problems;
    fail(`personality guard: ${guard.problems.join("; ")}`);
    return;
  }

  // 4. Commit in the worktree, stamp it as gated.
  const filesChanged = gitQuiet(["diff", "--stat"], worktreePath);
  gitQuiet(["add", "-A"], worktreePath);
  const commitResult = gitQuiet(
    ["commit", "-m", `Implement task: ${task.filename}\n\n${task.frontmatter.title ?? ""}`],
    worktreePath,
  );
  if (!commitResult.ok) {
    fail(`could not commit change: ${commitResult.error}`);
    return;
  }
  const newCommit = git(["rev-parse", "HEAD"], worktreePath);
  logEntry.commit = newCommit;
  logEntry.filesChanged = filesChanged.output;
  stampPass(worktreePath, "HEAD");

  // 5. Merge into main (refused unless the merged code carries a gate pass).
  const mergeResult = landMerge({ root: ROOT, branch });
  if (!mergeResult.ok) {
    fail(mergeResult.error);
    return;
  }
  branchMerged = true;

  cleanupWorktree(worktreePath, branch, worktreeCreated, branchMerged);

  // 6. Restart and health-check.
  ensureLiveDependencies(logEntry);
  try {
    restartService();
  } catch (err) {
    fail(`service restart command failed: ${err?.message ?? String(err)}`);
    return;
  }

  const healthy = await waitForHealthy();
  logEntry.healthCheck = healthy ? "healthy" : "unhealthy";

  if (!healthy) {
    fail(`health check failed after deploying commit ${newCommit} (restarted, still unhealthy)`);
    return;
  }

  // 7. Success: move task to done.
  log(`run-build-task: healthy at commit ${newCommit}.`);
  logEntry.outcome = "done";

  const destPath = moveTaskFile({
    task,
    destDir: DONE_DIR,
    heading: "Done",
    note: `Deployed as commit ${newCommit}.`,
  });
  logEntry.movedTo = path.relative(ROOT, destPath);

  gitQuiet(["add", "-A", "--", "tasks/pending", "tasks/done"]);
  gitQuiet(["commit", "-m", `Complete task: ${task.filename} (${newCommit.slice(0, 8)})`]);

  // 8. Push (the pre-push hook re-checks the gate stamp). A failed push is
  // logged but doesn't undo a healthy deploy.
  const push = landPush({ root: ROOT });
  logEntry.pushed = push.ok;
  if (!push.ok) logEntry.pushError = push.error;

  writeLog(logEntry);
}

function restartServiceBestEffort(logEntry) {
  try {
    restartService();
    logEntry.rollbackRestart = "ok";
  } catch (err) {
    logEntry.rollbackRestart = `failed: ${err?.message ?? String(err)}`;
  }
}

// Safety net: the live node_modules must exist before the service restarts,
// or it crash-loops on a missing package and no code rollback can fix that.
function ensureLiveDependencies(logEntry) {
  if (fs.existsSync(path.join(ROOT, "node_modules", "dotenv"))) return;
  log("run-build-task: live node_modules missing or incomplete — reinstalling");
  try {
    execFileSync("npm", ["ci"], { cwd: ROOT, stdio: "ignore" });
    logEntry.dependenciesReinstalled = true;
  } catch (err) {
    logEntry.dependenciesReinstalled = `failed: ${err?.message ?? String(err)}`;
  }
}

function cleanupWorktree(worktreePath, branch, worktreeCreated, branchMerged) {
  if (!worktreeCreated) return;
  gitQuiet(["worktree", "remove", "--force", worktreePath]);
  gitQuiet(["branch", branchMerged ? "-d" : "-D", branch]);
}

// Works through up to MAX_TASKS_PER_RUN pending tasks in queue order. A failed task is moved to
// tasks/failed/ and the run carries on with the next one — a task that
// depended on an earlier one failing is an accepted outcome. The attempted
// set guards against looping forever if a task file couldn't be moved out of
// pending.
async function main() {
  const attempted = new Set();
  let processed = 0;

  while (processed < MAX_TASKS_PER_RUN) {
    const task = pickNextPendingTask();
    if (!task || attempted.has(task.filename)) break;
    attempted.add(task.filename);
    try {
      await processTask(task);
    } catch (err) {
      log(`run-build-task: unexpected error on ${task.filename}: ${err?.message ?? String(err)}`);
      process.exitCode = 1;
    }
    processed++;
  }

  if (processed === 0) {
    log("run-build-task: no pending tasks.");
    writeLog({ timestamp: new Date().toISOString(), outcome: "no_pending_tasks" });
  } else {
    log(`run-build-task: queue finished, processed ${processed} task(s).`);
  }
}

main();
