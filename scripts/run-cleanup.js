import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { log } from "../src/logger.js";
import { runFixLoop, describeGateOutcome, writeGateFailure, gateRulesForPrompt, stampPass, landMerge, landPush, checkRootOnMain } from "./lib/gate.js";

// Perpetual, scheduled "soft" cleanup pass. Unlike run-build-task.js this is
// not a one-shot task that moves to tasks/done — it re-runs forever, each time
// making a few small, behavior-preserving improvements to the codebase (logic,
// UI, scripts, docs), then verifying the result.
//
// Scope: our own code only (git-tracked files) — never node_modules, dist, or
// any third-party library. That includes the Vue/Quasar web app in webapp/.
//
// Flow: isolated worktree off main -> Claude makes conservative improvements
// -> verify (syntax check, npm test if defined, webapp build, server boot
// smoke test) -> on failure feed the output back to Claude to fix, via the
// shared test gate (scripts/lib/gate.js: green-path + adversarial suites, abort
// on a failure recurring in 3 rounds or 8 rounds total) -> not clean: throw the worktree
// away, main is untouched, everything (including the discarded diff) is
// logged. Clean: merge to main, rebuild webapp/dist if the web app changed,
// restart + health-check (roll back if unhealthy), push.
//
// Usage: node scripts/run-cleanup.js
// Cron:  0 5 * * * cd /var/www/deskmates && node scripts/run-cleanup.js >> logs/cron.log 2>&1
//        (5am: clear of the ideation 2am, build 0/3am, and Sunday 4am reflection jobs)

const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");

const ROOT = process.cwd();
const LOGS_DIR = path.join(ROOT, "logs");
const PORT = Number(process.env.PORT) || 8080;

const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_CHECK_ATTEMPTS = 6;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const PRIOR_RUNS_IN_PROMPT = 5;
const LOCK_PATH = path.join(LOGS_DIR, "self-cleanup.lock");

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

function writeLog(entry, stamp) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `self-cleanup-${stamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
  log(`Wrote cleanup log to ${path.relative(ROOT, logPath)}`);
}

// Summaries of the last few runs, so each pass continues where the previous
// one left off instead of rediscovering (or redoing/undoing) the same things.
function priorRunSummaries() {
  if (!fs.existsSync(LOGS_DIR)) return "(none yet — this is the first run)";
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => /^self-cleanup-.*\.json$/.test(f))
    .sort()
    .slice(-PRIOR_RUNS_IN_PROMPT);
  const summaries = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), "utf8"));
      const text = entry.claude?.resultText ?? entry.failureReason ?? "";
      summaries.push(`- ${entry.timestamp} [${entry.outcome}]: ${String(text).slice(0, 1200)}`);
    } catch {
      // Unreadable log — skip it.
    }
  }
  return summaries.length ? summaries.join("\n") : "(none yet — this is the first run)";
}

function buildPrompt() {
  return `You are Deskmates's automated maintenance agent, working inside an isolated git worktree. Your job is one SOFT, iterative cleanup pass over the whole repo: the server logic in server.js and src/, the scripts/, the web app (webapp/src — Vue 3 + Quasar components, composables, vite config — plus webapp/index.html and public/), config handling, and the docs.

Scope is OUR code only. Never read, analyze, or edit node_modules/ (root or webapp/), webapp/dist/, lockfiles, or any third-party library code; only look at how our code uses those libraries (e.g. unused Quasar imports, misuse of Vue reactivity/watchers/lifecycle hooks). Find inefficiencies and correct them — but only ever by making the codebase cleaner without changing what it does.

What counts as a good change:
- Dead code, unused imports/exports/variables, unreachable branches.
- Duplicated logic that can be folded into an existing helper.
- Needless work: repeated file reads or config parses on hot paths, redundant loops/allocations, sequential awaits that are safely parallel, listeners or timers that are never cleaned up.
- Fragile or inconsistent error handling, obvious latent bugs (fix them minimally).
- Stale or misleading comments and docs (README.md, CAPABILITIES.md, WEBAPP.md) that no longer match the code.
- Web app: needless re-renders and over-broad watchers/computeds, work done every animation frame that could be cached, WebSocket/audio/event listeners and timers not removed on unmount, duplicated logic across the Visualizer* components or composables that belongs in a shared composable, unused components/props/emits/CSS/assets.

Ground rules — this is what "soft" means:
- Behavior-preserving. Same inputs must produce the same outputs, same protocol messages, same files written, same UI. If you are not confident a change is safe, leave it and mention it in your report instead.
- Small and incremental. Make a handful (roughly 3-8) of well-contained improvements, most valuable first. Do not rewrite modules, rename public APIs or protocol fields, reorganize directories, or chase style nitpicks. It is fine, and expected, to leave plenty for the next run.
- Do NOT touch: tasks/, logs/, data/, config.json, personalities/ content, .env, package.json dependencies or lockfiles, or the git history. Do not add new dependencies.
- Do not run git commit, git push, or touch branches — the orchestrating script does that after verifying your work.
- If you touch user-facing behavior descriptions, keep CAPABILITIES.md accurate; otherwise leave it alone.
- Verify as you go: run \`node --check\` on server-side files you edit, \`npm test\`, and \`npm run build\` inside webapp/ if you touched it (it must build clean; the UI must look and behave the same).
- If you find nothing worth changing, change nothing. An empty pass is a valid result.

${gateRulesForPrompt()}

Recent cleanup runs (continue from these; do not redo or reverse them):
${priorRunSummaries()}

Finish with a short plain-text report: what you changed and why (one line each), and a "Next candidates" list of things you noticed but deliberately left alone. That report is stored in the run log and shown to the next run.`;
}

// Appended to the gate's failure feedback for cleanup runs.
const CLEANUP_FIX_HINT = `\n\nThis is a behavior-preserving cleanup: prefer reverting or narrowing your own cleanup change over adding new code to work around a failure — a change that can't be made to pass cleanly should simply be dropped.`;

function invokeClaude(prompt, cwd, resumeSessionId) {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // Strip Anthropic API credentials so the session bills to the logged-in
  // subscription rather than per-token to the bot's API key (same as
  // run-build-task.js).
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

// Vite production build of the web app (output stays in that checkout's own
// gitignored dist/). Returns null on success or the failure text.
function buildWebapp(cwd) {
  try {
    execFileSync("npm", ["run", "build"], {
      cwd: path.join(cwd, "webapp"),
      encoding: "utf8",
      stdio: "pipe",
      timeout: TEST_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    return `webapp npm run build failed:\n${((err?.stdout ?? "") + (err?.stderr ?? "")).slice(-4000)}`;
  }
}

function httpOk(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => {
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
    if (isServiceActive() && (await httpOk())) return true;
  }
  return false;
}

function restartService() {
  execFileSync("sudo", ["systemctl", "restart", "deskmates.service"]);
}

function cleanupWorktree(worktreePath, branch, branchMerged) {
  gitQuiet(["worktree", "remove", "--force", worktreePath]);
  gitQuiet(["branch", branchMerged ? "-d" : "-D", branch]);
}

// A stale lock (crashed run) is ignored after the Claude timeout plus slack.
function acquireLock() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  try {
    const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    if (age < CLAUDE_TIMEOUT_MS * 3) return false;
  } catch {
    // No lock file — free to proceed.
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

async function main() {
  const stamp = timestamp();
  const entry = { timestamp: new Date().toISOString(), rounds: [] };

  if (!acquireLock()) {
    log("run-cleanup: another cleanup run appears to be in progress — exiting.");
    return;
  }

  try {
    await runCleanup(stamp, entry);
  } catch (err) {
    entry.outcome = "error";
    entry.failureReason = `unexpected error: ${err?.message ?? String(err)}`;
    log(`run-cleanup: ${entry.failureReason}`);
    process.exitCode = 1;
    writeLog(entry, stamp);
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
}

async function runCleanup(stamp, entry) {
  // Don't stack a cleanup on top of uncommitted work or an in-flight build.
  const dirty = gitQuiet(["status", "--porcelain", "--", ".", ":!logs"]);
  if (!dirty.ok || dirty.output.trim() !== "") {
    entry.outcome = "skipped";
    entry.failureReason = "main working tree is not clean";
    log("run-cleanup: main working tree is not clean — skipping this run.");
    writeLog(entry, stamp);
    return;
  }

  // The worktree below always forks from main; if ROOT isn't actually on
  // main (e.g. left on a feature branch by an interactive session), landMerge
  // would merge this run's work into that other branch instead — see
  // checkRootOnMain(). Catch that before any worktree is created.
  const rootCheck = checkRootOnMain(ROOT);
  if (!rootCheck.ok) {
    entry.outcome = "skipped";
    entry.failureReason = rootCheck.error;
    log(`run-cleanup: ${rootCheck.error}`);
    writeLog(entry, stamp);
    return;
  }

  const preEditCommit = git(["rev-parse", "HEAD"]);
  const branch = `self-cleanup-${stamp}`;
  const worktreePath = path.join(ROOT, "..", `deskmates-cleanup-${stamp}`);
  Object.assign(entry, { preEditCommit, branch, worktreePath });

  let branchMerged = false;

  // Failure path: main was never touched (or, post-merge, is reset), the
  // worktree and branch are removed, and the full diff is saved to logs/ so
  // the attempted work isn't lost with the revert.
  const abandon = (reason, worktreeExists = true) => {
    log(`run-cleanup: ABANDONED — ${reason}`);
    entry.outcome = "reverted";
    entry.failureReason = reason;

    if (branchMerged) {
      entry.rollback = gitQuiet(["reset", "--hard", preEditCommit]);
      try {
        restartService();
        entry.rollbackRestart = "ok";
      } catch (err) {
        entry.rollbackRestart = `failed: ${err?.message ?? String(err)}`;
      }
    }

    if (worktreeExists) {
      const diff = gitQuiet(["diff", "HEAD"], worktreePath);
      if (diff.ok && diff.output) {
        const patchPath = path.join(LOGS_DIR, `self-cleanup-${stamp}.patch`);
        fs.writeFileSync(patchPath, diff.output + "\n");
        entry.discardedPatch = path.relative(ROOT, patchPath);
      }
      cleanupWorktree(worktreePath, branch, branchMerged);
    }
    process.exitCode = 1;
    writeLog(entry, stamp);
  };

  // 1. Worktree off latest main, with its own copy of node_modules.
  const wt = gitQuiet(["worktree", "add", "-b", branch, worktreePath, "main"]);
  if (!wt.ok) {
    abandon(`could not create worktree: ${wt.error}`, false);
    return;
  }
  // Dependencies are gitignored: give the worktree its own copies (root and
  // webapp) rather than symlinks, so nothing run in the worktree can touch the
  // live installs.
  for (const dir of ["node_modules", path.join("webapp", "node_modules")]) {
    try {
      execFileSync("cp", ["-a", "--reflink=auto", path.join(ROOT, dir), path.join(worktreePath, dir)], {
        stdio: "ignore",
      });
    } catch (err) {
      log(`run-cleanup: could not copy ${dir}, verification may fail`, { error: err?.message ?? String(err) });
    }
  }

  // 2. Cleanup pass.
  let claudeResult;
  try {
    claudeResult = invokeClaude(buildPrompt(), worktreePath);
  } catch (err) {
    abandon(`claude invocation failed: ${err?.message ?? String(err)}`);
    return;
  }
  entry.claude = {
    isError: claudeResult.is_error ?? false,
    numTurns: claudeResult.num_turns,
    durationMs: claudeResult.duration_ms,
    totalCostUsd: claudeResult.total_cost_usd,
    resultText: claudeResult.result,
  };

  const changed = gitQuiet(["status", "--porcelain"], worktreePath);
  if (!changed.ok || changed.output.trim() === "") {
    entry.outcome = "no_changes";
    log("run-cleanup: nothing worth changing this run.");
    cleanupWorktree(worktreePath, branch, false);
    writeLog(entry, stamp);
    return;
  }

  // 3. Test gate, feeding failures back to the same session until clean or
  // the oscillation (3 rounds) / backstop (8 rounds) limits hit.
  let sessionId = claudeResult.session_id;
  const loop = await runFixLoop({
    cwd: worktreePath,
    baseRef: "main",
    // A cleanup must not change behavior, so it needn't add tests; lines it does add must still be covered.
    gateOptions: { requireTests: false },
    onRound: (r) => log(`run-cleanup: gate round ${r.round} ${r.passed ? "clean" : `failed (${r.failures.length} failure(s))`}`),
    fix: async (prompt) => {
      const fix = invokeClaude(prompt + CLEANUP_FIX_HINT, worktreePath, sessionId);
      sessionId = fix.session_id ?? sessionId;
    },
  });
  entry.gate = { outcome: loop.outcome, rounds: loop.rounds };
  if (loop.outcome !== "clean") {
    gitQuiet(["add", "-A"], worktreePath); // include new (untracked) files in the saved diff
    const diff = gitQuiet(["diff", "--cached", "HEAD"], worktreePath).output;
    entry.gateFailureLog = writeGateFailure({ root: ROOT, stamp, job: "run-cleanup", subject: stamp, loop, diff });
    abandon(`${describeGateOutcome(loop)} — reverted, main untouched (details: ${entry.gateFailureLog})`);
    return;
  }

  // The fix loop may have reverted everything; nothing left to commit is fine.
  const stillChanged = gitQuiet(["status", "--porcelain"], worktreePath);
  if (!stillChanged.ok || stillChanged.output.trim() === "") {
    entry.outcome = "no_changes";
    cleanupWorktree(worktreePath, branch, false);
    writeLog(entry, stamp);
    return;
  }

  // 4. Commit, merge, deploy, push.
  entry.filesChanged = gitQuiet(["diff", "--stat", "HEAD"], worktreePath).output;
  gitQuiet(["add", "-A"], worktreePath);
  const commit = gitQuiet(["commit", "-m", `Cleanup pass ${stamp}\n\nAutomated behavior-preserving cleanup (scripts/run-cleanup.js).`], worktreePath);
  if (!commit.ok) {
    abandon(`could not commit change: ${commit.error}`);
    return;
  }
  entry.commit = git(["rev-parse", "HEAD"], worktreePath);
  stampPass(worktreePath, "HEAD");

  const merge = landMerge({ root: ROOT, branch });
  if (!merge.ok) {
    abandon(merge.error);
    return;
  }
  branchMerged = true;
  cleanupWorktree(worktreePath, branch, true);

  // nginx serves webapp/dist, which is gitignored — a merge alone doesn't
  // update it, so rebuild the live copy when the web app changed.
  const webappChanged = gitQuiet(["diff", "--name-only", `${preEditCommit}..HEAD`, "--", "webapp"]);
  if (webappChanged.ok && webappChanged.output.trim() !== "") {
    const liveBuildFailure = buildWebapp(ROOT);
    entry.webappRebuilt = !liveBuildFailure;
    if (liveBuildFailure) {
      abandon(`live webapp build failed after merge: ${liveBuildFailure}`, false);
      buildWebapp(ROOT); // best-effort: rebuild dist from the rolled-back source
      return;
    }
  }

  try {
    restartService();
  } catch (err) {
    abandon(`service restart command failed: ${err?.message ?? String(err)}`, false);
    return;
  }
  const healthy = await waitForHealthy();
  entry.healthCheck = healthy ? "healthy" : "unhealthy";
  if (!healthy) {
    abandon(`health check failed after deploying ${entry.commit}`, false);
    if (entry.webappRebuilt) buildWebapp(ROOT);
    return;
  }

  const push = landPush({ root: ROOT });
  entry.pushed = push.ok;
  if (!push.ok) entry.pushError = push.error;

  entry.outcome = "merged";
  log(`run-cleanup: merged ${entry.commit}, healthy${push.ok ? ", pushed" : ", PUSH FAILED (see log)"}.`);
  writeLog(entry, stamp);
}

main();
