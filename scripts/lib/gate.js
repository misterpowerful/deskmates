import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, execFileSync } from "node:child_process";

// The test gate (see TESTING-GATE.md). Every automated process that builds or
// changes code goes through runFixLoop() and then landMerge()/landPush() —
// nothing else in scripts/ may merge or push (tests/adversarial/gate-enforcement
// checks this). A clean gate run leaves a stamp keyed by a fingerprint of the
// code tree; the git hooks in .githooks/ refuse to merge or push code that has
// no stamp.

export const MAX_ROUNDS = 8;
export const REPEAT_LIMIT = 3;
const STAGE_TIMEOUT_MS = 5 * 60 * 1000;
const SUITES = ["green", "adversarial"];
// Paths that are pipeline bookkeeping, not code: changes here never need a gate pass.
const NON_CODE_PREFIXES = ["tasks/", "logs/", "data/"];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitQuiet(args, cwd) {
  try {
    return { ok: true, output: git(args, cwd) };
  } catch (err) {
    return {
      ok: false,
      output: err?.stdout ?? "",
      stderr: err?.stderr ?? "",
      error: err?.message ?? String(err),
    };
  }
}

// `err.message` from a failed execFileSync is just "Command failed: <cmd>" —
// the actual diagnostic text (conflict markers, "Automatic merge failed",
// untracked-file-would-be-overwritten warnings, ...) is in stdout/stderr.
// Truncated to a few KB so a runaway diff can't blow up the failure note.
const MAX_GIT_DETAIL_LEN = 4000;

export function gitFailureDetail(result) {
  const detail = [result?.output, result?.stderr]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!detail) return "";
  return detail.length > MAX_GIT_DETAIL_LEN ? `${detail.slice(0, MAX_GIT_DETAIL_LEN)}... [truncated]` : detail;
}

export function withGitDetail(message, result) {
  const detail = gitFailureDetail(result);
  return detail ? `${message}\n${detail}` : message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- failure parsing

// Collapses run-specific noise (numbers, paths, hex, timing) so the same
// underlying failure produces the same text across rounds.
export function normalizeMessage(text) {
  return String(text ?? "")
    .replace(/\/[^\s:'"]+/g, "<path>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Failing test names out of `node --test --test-reporter=tap` output.
export function parseTapFailures(output) {
  const failures = [];
  const lines = String(output ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.*?)(?:\s+#\s.*)?$/);
    if (!m) continue;
    let message = "";
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const e = lines[j].match(/^\s*error:\s*(.*)$/);
      if (e) {
        message = e[1].replace(/^['"]|['"]$/g, "");
        break;
      }
      if (/^\s*(not )?ok \d+ - /.test(lines[j])) break;
    }
    failures.push({ id: m[1].trim(), message });
  }
  return failures;
}

export function fingerprintFailure(f) {
  return f.id ? `${f.stage}|${f.id}` : `${f.stage}|${normalizeMessage(f.message)}`;
}

// Tracks how many separate rounds each failure fingerprint has appeared in.
// A fingerprint reaching `repeatLimit` rounds means the fix loop is going in
// circles (fix adversarial -> green breaks -> fix green -> adversarial breaks)
// or is stuck on one failure, and the whole change is abandoned.
export class OscillationTracker {
  constructor({ repeatLimit = REPEAT_LIMIT } = {}) {
    this.repeatLimit = repeatLimit;
    this.rounds = new Map();
  }

  record(failures) {
    let tripped = null;
    for (const fp of new Set(failures.map(fingerprintFailure))) {
      const count = (this.rounds.get(fp) ?? 0) + 1;
      this.rounds.set(fp, count);
      if (count >= this.repeatLimit && (!tripped || count > tripped.count)) tripped = { fingerprint: fp, count };
    }
    return tripped;
  }

  countOf(failure) {
    return this.rounds.get(fingerprintFailure(failure)) ?? 0;
  }
}

// ---------------------------------------------------------------- static test checks

const TEST_CALL = /^\s*(?:test|it)(?:\.\w+)?\s*\(/gm;
const SKIP_MARKER = /\b(?:test|it|describe)\.(?:skip|todo|only)\b|\{[^{}]*\b(?:skip|todo|only)\s*:(?!\s*false)/;

export function countTestCalls(source) {
  return (String(source).match(TEST_CALL) ?? []).length;
}

export function findSkipMarkers(source) {
  return SKIP_MARKER.test(String(source));
}

// Source files whose change demands tests in both suites.
export function requiresTests(file) {
  if (file.startsWith("tests/")) return false;
  return file.startsWith("src/") || file === "server.js" || file.startsWith("scripts/");
}

export function checkTestPresence(changedFiles, { require = true } = {}) {
  if (!require || !changedFiles.some(requiresTests)) return [];
  const failures = [];
  for (const suite of SUITES) {
    if (!changedFiles.some((f) => f.startsWith(`tests/${suite}/`) && f.endsWith(".js"))) {
      failures.push({
        stage: "test-presence",
        message: `Source changed (${changedFiles.filter(requiresTests).slice(0, 5).join(", ")}) but no test was added or modified in tests/${suite}/. Every code change needs both green-path and adversarial tests.`,
      });
    }
  }
  return failures;
}

export function checkRatchet(baseCounts, currentCounts, skipFiles) {
  const failures = [];
  for (const suite of SUITES) {
    if ((currentCounts[suite] ?? 0) < (baseCounts[suite] ?? 0)) {
      failures.push({
        stage: "test-ratchet",
        message: `tests/${suite}/ went from ${baseCounts[suite]} to ${currentCounts[suite]} tests. Tests may not be removed.`,
      });
    }
  }
  for (const f of skipFiles) {
    failures.push({ stage: "test-ratchet", message: `${f} uses skip/todo/only, which is not allowed.` });
  }
  return failures;
}

function listSuiteFiles(cwd, suite) {
  const dir = path.join(cwd, "tests", suite);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".js")).map((n) => `tests/${suite}/${n}`);
}

function currentSuiteState(cwd) {
  const counts = {};
  const skipFiles = [];
  for (const suite of SUITES) {
    counts[suite] = 0;
    for (const file of listSuiteFiles(cwd, suite)) {
      const src = fs.readFileSync(path.join(cwd, file), "utf8");
      counts[suite] += countTestCalls(src);
      if (findSkipMarkers(src)) skipFiles.push(file);
    }
  }
  return { counts, skipFiles };
}

function baseSuiteCounts(cwd, baseRef) {
  const counts = {};
  for (const suite of SUITES) {
    counts[suite] = 0;
    const files = gitQuiet(["ls-tree", "-r", "--name-only", baseRef, "--", `tests/${suite}`], cwd);
    if (!files.ok || !files.output) continue;
    for (const file of files.output.split("\n").filter((f) => f.endsWith(".js"))) {
      const show = gitQuiet(["show", `${baseRef}:${file}`], cwd);
      if (show.ok) counts[suite] += countTestCalls(show.output);
    }
  }
  return counts;
}

// Files changed relative to baseRef, including uncommitted and untracked ones.
export function changedFilesSince(cwd, baseRef) {
  const tracked = gitQuiet(["diff", "--name-only", baseRef], cwd);
  const untracked = gitQuiet(["ls-files", "--others", "--exclude-standard"], cwd);
  const all = [tracked.output, untracked.output].join("\n").split("\n").filter(Boolean);
  return [...new Set(all)];
}

// ---------------------------------------------------------------- coverage of added lines

// Importable library code: added lines here must be exercised by the suites.
// Entry-point scripts (scripts/*.js) and server.js run their work on import,
// so they can't be unit-loaded; the boot check covers them instead.
export function requiresCoverage(file) {
  return file.endsWith(".js") && (file.startsWith("src/") || file.startsWith("scripts/lib/"));
}

// Blank lines, comments and bare closers carry no executable code.
export function isCodeLine(text) {
  return !/^\s*(?:\/\/.*|\/\*.*|\*.*|[)}\];,]*)\s*$/.test(text);
}

// lcov text -> Map<file, Map<line, hits>>. Hits for repeated files are summed.
export function parseLcov(text, cwd = "") {
  const files = new Map();
  let cur = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      let file = raw.slice(3).trim();
      if (cwd && path.isAbsolute(file)) file = path.relative(cwd, file);
      cur = files.get(file) ?? new Map();
      files.set(file, cur);
    } else if (cur && raw.startsWith("DA:")) {
      const [line, hits] = raw.slice(3).split(",").map(Number);
      if (Number.isInteger(line) && Number.isFinite(hits)) cur.set(line, (cur.get(line) ?? 0) + hits);
    } else if (raw === "end_of_record") {
      cur = null;
    }
  }
  return files;
}

export function mergeCoverage(maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [file, lines] of m) {
      const dest = out.get(file) ?? new Map();
      for (const [line, hits] of lines) dest.set(line, (dest.get(line) ?? 0) + hits);
      out.set(file, dest);
    }
  }
  return out;
}

// `git diff -U0` text -> Map<file, [{ line, text }]> of added lines.
export function parseAddedLines(diff) {
  const added = new Map();
  let file = null;
  let next = 0;
  for (const raw of String(diff ?? "").split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.replace(/^\+\+\+ b\//, "");
      continue;
    }
    const hunk = raw.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (file && raw.startsWith("+") && !raw.startsWith("+++")) {
      if (!added.has(file)) added.set(file, []);
      added.get(file).push({ line: next++, text: raw.slice(1) });
    }
  }
  return added;
}

// A covered-lines check: every added executable line in importable code must
// have been hit by a test. A file no test loaded at all counts as uncovered.
export function findUncoveredAdded(added, coverage) {
  const failures = [];
  for (const [file, lines] of added) {
    if (!requiresCoverage(file)) continue;
    const code = lines.filter((l) => isCodeLine(l.text));
    if (code.length === 0) continue;
    const fileCov = coverage.get(file);
    const missed = fileCov
      ? code.filter((l) => fileCov.has(l.line) && fileCov.get(l.line) === 0)
      : code;
    if (missed.length === 0) continue;
    const list = missed.slice(0, 12).map((l) => l.line).join(", ");
    failures.push({
      stage: "coverage",
      id: file,
      message: fileCov
        ? `Added lines not exercised by any test: ${list}${missed.length > 12 ? ", ..." : ""}. Add green-path and adversarial tests that run them.`
        : `${file} has added code but no test loads this file. Import it from a test in each suite (extract testable logic into src/ if the file can't be imported offline).`,
    });
  }
  return failures;
}

// Added lines vs baseRef, including untracked files.
function addedLinesSince(cwd, baseRef) {
  const diff = gitQuiet(["diff", "-U0", baseRef], cwd);
  const added = parseAddedLines(diff.ok ? diff.output : "");
  const untracked = gitQuiet(["ls-files", "--others", "--exclude-standard"], cwd);
  for (const file of (untracked.output || "").split("\n").filter(Boolean)) {
    try {
      added.set(file, fs.readFileSync(path.join(cwd, file), "utf8").split("\n").map((text, i) => ({ line: i + 1, text })));
    } catch {
      // unreadable or a directory: nothing to check
    }
  }
  return added;
}

// ---------------------------------------------------------------- stages

// No API keys or tokens reach test code: it must run fully offline.
function testEnv() {
  const keep = ["PATH", "HOME", "LANG", "TZ", "TMPDIR"];
  const env = { NODE_ENV: "test", GATE_RUN: "1" };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function listJsFiles(cwd) {
  const out = git(["ls-files", "--", "*.js", "*.mjs"], cwd);
  const files = out ? out.split("\n") : [];
  // Untracked new files count too (gate runs before the commit).
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "*.js", "*.mjs"], cwd);
  return [...new Set([...files, ...(untracked ? untracked.split("\n") : [])])].filter((f) =>
    fs.existsSync(path.join(cwd, f)),
  );
}

function syntaxStage(cwd) {
  const failures = [];
  for (const file of listJsFiles(cwd)) {
    const r = spawnSync("node", ["--check", file], { cwd, encoding: "utf8" });
    if (r.status !== 0) failures.push({ stage: "syntax", id: file, message: (r.stderr || r.stdout).slice(-1500) });
  }
  return failures;
}

// Runs one suite with the TAP reporter on stdout and lcov coverage to a temp
// file. Returns { failures, coverage }.
function suiteStage(cwd, suite) {
  const stage = `test:${suite}`;
  const lcovDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lcov-"));
  const lcovPath = path.join(lcovDir, "coverage.lcov");
  const r = spawnSync(
    "node",
    [
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-include=src/**",
      "--test-coverage-include=scripts/lib/**",
      "--test-reporter=tap",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      `tests/${suite}/*.test.js`,
    ],
    { cwd, env: testEnv(), encoding: "utf8", timeout: STAGE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  let coverage = new Map();
  try {
    coverage = parseLcov(fs.readFileSync(lcovPath, "utf8"), cwd);
  } catch {
    // no coverage file (suite crashed); the failure below explains why
  }
  fs.rmSync(lcovDir, { recursive: true, force: true });
  if (r.status === 0) return { failures: [], coverage };
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const parsed = parseTapFailures(output);
  if (parsed.length > 0) return { failures: parsed.map((f) => ({ stage, ...f })), coverage };
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { failures: [{ stage, message: (timedOut ? "timed out\n" : "") + output.slice(-2000) }], coverage };
}

function webappStage(cwd) {
  const r = spawnSync("npm", ["run", "build"], {
    cwd: path.join(cwd, "webapp"),
    encoding: "utf8",
    timeout: STAGE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 0) return [];
  return [{ stage: "webapp-build", message: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-3000) }];
}

function httpOk(port) {
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

// Boots server.js on a throwaway port and checks GET / answers — catches
// import errors and top-level crashes a syntax check can't.
async function bootStage(cwd) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn("node", ["server.js"], {
    cwd,
    env: { ...process.env, PORT: String(port), BOT_AUTH_TOKEN: process.env.BOT_AUTH_TOKEN || "gate-smoke" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  let exited = false;
  child.on("exit", () => (exited = true));
  let ok = false;
  for (let i = 0; i < 10 && !exited && !ok; i++) {
    await sleep(500);
    ok = await httpOk(port);
  }
  child.kill("SIGTERM");
  return ok ? [] : [{ stage: "boot", message: `server.js did not come up on port ${port}\n${output.slice(-2000)}` }];
}

// One full gate pass over the working tree at `cwd`, measured against baseRef.
// requireTests: demand tests in both suites for any source change (jobs whose
// changes must not alter behavior, like cleanup, turn this off; the coverage
// check on added lines still applies).
export async function runGate(cwd, { baseRef = "main", boot = true, requireTests = true } = {}) {
  const failures = [];
  const stages = [];
  const run = async (name, fn) => {
    const f = await fn();
    stages.push({ stage: name, passed: f.length === 0 });
    failures.push(...f);
  };

  const changed = changedFilesSince(cwd, baseRef);
  await run("syntax", () => syntaxStage(cwd));
  await run("test-presence", () => checkTestPresence(changed, { require: requireTests }));
  await run("test-ratchet", () => {
    const { counts, skipFiles } = currentSuiteState(cwd);
    return checkRatchet(baseSuiteCounts(cwd, baseRef), counts, skipFiles);
  });
  const coverages = [];
  let suitesClean = true;
  for (const suite of SUITES) {
    await run(`test:${suite}`, () => {
      const res = suiteStage(cwd, suite);
      coverages.push(res.coverage);
      if (res.failures.length > 0) suitesClean = false;
      return res.failures;
    });
  }
  if (suitesClean) {
    await run("coverage", () => findUncoveredAdded(addedLinesSince(cwd, baseRef), mergeCoverage(coverages)));
  }
  if (changed.some((f) => f.startsWith("webapp/") || f.startsWith("public/"))) {
    await run("webapp-build", () => webappStage(cwd));
  }
  if (boot && failures.length === 0) await run("boot", () => bootStage(cwd));

  return { passed: failures.length === 0, failures, stages };
}

// ---------------------------------------------------------------- fix loop

export function gateRulesForPrompt() {
  return `TEST GATE (mandatory, enforced by the orchestrating script): your change must come with tests in BOTH suites — tests/green/*.test.js (valid input produces the documented result) and tests/adversarial/*.test.js (malformed, hostile, oversized, out-of-order input fails safely). Use node:test, keep them fully offline (no network, no API keys, no running server, no mocking Anthropic/ElevenLabs clients — leave those out). Run \`npm test\` before you finish. Every line you add under src/ or scripts/lib/ must be executed by those tests (the gate measures this; code no test can load, such as top-level scripts and server.js, should stay thin — move logic into src/ so it can be tested). Never delete, skip, .only or .todo a test, and never weaken an assertion just to make it pass; if a test is wrong, fix it to assert the correct behavior. Removing or skipping any test aborts the whole run for human review, so if dead code still has tests, leave both in place and mention it in your report. The script re-runs the whole gate after you finish and feeds failures back to you; if the same failure recurs across 3 rounds the whole change is thrown away.`;
}

function failurePrompt(round, maxRounds, result, tracker, repeatLimit) {
  const lines = result.failures.slice(0, 25).map((f) => {
    const seen = tracker.countOf(f);
    const warn = seen >= repeatLimit - 1 ? ` [seen in ${seen} rounds — ONE more and the whole change is discarded]` : "";
    return `- [${f.stage}]${f.id ? ` ${f.id}` : ""}${warn}\n  ${String(f.message ?? "").slice(0, 600).replace(/\n/g, "\n  ")}`;
  });
  return `The test gate failed (round ${round} of ${maxRounds}).\n\n${lines.join("\n")}\n\nFix the root cause. A fix for one suite must not break the other: when green-path and adversarial tests seem to disagree, reconcile the code AND both expectations together rather than flipping between them. Do not delete, skip or weaken tests. Same ground rules as before (no git commit, nothing under tasks/, logs/, data/). End with one line saying what you fixed.`;
}

// Runs the gate, hands failures to `fix(prompt)`, and repeats until clean,
// a fingerprint recurs in `repeatLimit` rounds (oscillation), maxRounds is
// hit (backstop), or the fixer itself throws.
// outcome: "clean" | "oscillation" | "backstop" | "fixer_error" | "needs_review"
export async function runFixLoop({
  cwd,
  baseRef = "main",
  fix,
  maxRounds = MAX_ROUNDS,
  repeatLimit = REPEAT_LIMIT,
  gateOptions = {},
  gate = runGate,
  onRound = () => {},
}) {
  const tracker = new OscillationTracker({ repeatLimit });
  const rounds = [];

  for (let round = 1; round <= maxRounds; round++) {
    const result = await gate(cwd, { baseRef, ...gateOptions });
    rounds.push({ round, passed: result.passed, stages: result.stages, failures: result.failures });
    onRound(rounds[rounds.length - 1]);
    if (result.passed) return { outcome: "clean", rounds };

    // Removing or skipping tests is never something to loop on: it stops here
    // and the change is set aside for a human to review.
    if (result.failures.some((f) => f.stage === "test-ratchet")) return { outcome: "needs_review", rounds };

    const tripped = tracker.record(result.failures);
    if (tripped) return { outcome: "oscillation", rounds, tripped };
    if (round === maxRounds) return { outcome: "backstop", rounds };

    try {
      await fix(failurePrompt(round, maxRounds, result, tracker, repeatLimit));
    } catch (err) {
      return { outcome: "fixer_error", rounds, error: err?.message ?? String(err) };
    }
  }
  return { outcome: "backstop", rounds };
}

// Human-readable reason for a non-clean fix-loop result, for task notes/logs.
export function describeGateOutcome(loop) {
  switch (loop.outcome) {
    case "oscillation":
      return `test gate oscillation: ${loop.tripped.fingerprint} failed in ${loop.tripped.count} separate rounds`;
    case "backstop":
      return `test gate still failing after ${loop.rounds.length} rounds`;
    case "needs_review":
      return "tests were removed or skipped; needs human review (discarded diff is in the gate-failure log)";
    case "fixer_error":
      return `test gate fix attempt failed: ${loop.error}`;
    default:
      return `test gate ${loop.outcome}`;
  }
}

// Writes logs/gate-failure-<stamp>.json with every round's failures and the
// diff being discarded. Returns the repo-relative path.
export function writeGateFailure({ root, stamp, job, subject, loop, diff }) {
  const logsDir = path.join(root, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `gate-failure-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        job,
        subject,
        outcome: loop.outcome,
        reason: describeGateOutcome(loop),
        tripped: loop.tripped ?? null,
        rounds: loop.rounds,
        discardedDiff: diff ? String(diff).slice(0, 200_000) : undefined,
      },
      null,
      2,
    ),
  );
  return path.relative(root, file);
}

// ---------------------------------------------------------------- stamps + landing

// Fingerprint of a tree-ish's code: everything except tasks/, logs/, data/,
// independent of commit history, so a merge commit that only adds bookkeeping
// commits still matches the stamp of the gated branch.
export function codeFingerprint(cwd, treeish = "HEAD") {
  const listing = git(["ls-tree", "-r", treeish], cwd)
    .split("\n")
    .filter((line) => line && !NON_CODE_PREFIXES.some((p) => line.split("\t")[1]?.startsWith(p)))
    .join("\n");
  return crypto.createHash("sha256").update(listing).digest("hex");
}

function stampDir(cwd) {
  const common = git(["rev-parse", "--git-common-dir"], cwd);
  return path.join(path.resolve(cwd, common), "gate-pass");
}

export function stampPass(cwd, treeish = "HEAD") {
  const fp = codeFingerprint(cwd, treeish);
  fs.mkdirSync(stampDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(stampDir(cwd), fp), `${new Date().toISOString()}\n`);
  return fp;
}

export function hasStamp(cwd, fp) {
  return /^[0-9a-f]{64}$/.test(fp) && fs.existsSync(path.join(stampDir(cwd), fp));
}

// True if `git status --porcelain` output has any tracked (not untracked)
// changes. Runtime state like config.json is written straight to disk by the
// live process with no commit, so it shows up here as a plain modification.
export function hasTrackedChanges(statusPorcelain) {
  return String(statusPorcelain ?? "")
    .split("\n")
    .some((line) => line && !line.startsWith("??"));
}

// run-build-task.js and run-cleanup.js always fork their worktree from
// `baseRef` (main), but landMerge() merges into whatever ROOT currently has
// checked out — it never looks at the ref name itself. If an interactive
// session leaves the live checkout on some other branch, the merge target
// silently becomes that branch instead of main: a real 3-way merge of
// unrelated history that the gate stamp was never computed against. Callers
// must run this before creating any worktree, so a wrong branch aborts
// immediately with a clear cause instead of a stamp-mismatch error standing
// in for it after a wasted worktree/Claude invocation.
export function checkRootOnMain(root, baseRef = "main") {
  const current = gitQuiet(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (!current.ok) {
    return { ok: false, error: `could not determine the live checkout's current branch: ${current.error}` };
  }
  if (current.output !== baseRef) {
    return {
      ok: false,
      error: `live checkout is on branch '${current.output}', not ${baseRef} — refusing to merge until it's back on ${baseRef}`,
    };
  }
  return { ok: true };
}

// The only sanctioned way for automation to merge a branch into main. The
// result must carry a gate stamp; if main moved in a way that left the merged
// code ungated, the merge is undone.
//
// `root` is the live checkout the running service also reads and writes, so
// runtime state (config.json, webapp settings files) can carry uncommitted
// edits at merge time. Those are stashed (tracked files only, not untracked
// scratch files) before the merge and popped back on top immediately after,
// win or lose, so a merge never gets refused over live state that has
// nothing to do with the task's own change.
export function landMerge({ root, branch }) {
  const pre = git(["rev-parse", "HEAD"], root);
  const hadLiveChanges = hasTrackedChanges(gitQuiet(["status", "--porcelain"], root).output);

  if (hadLiveChanges) {
    const stash = gitQuiet(["stash", "push", "-m", "land-merge: live-state edits set aside for merge"], root);
    if (!stash.ok) {
      return {
        ok: false,
        error: withGitDetail(`could not stash uncommitted live-state changes before merge: ${stash.error}`, stash),
      };
    }
  }

  const merge = gitQuiet(["merge", "--no-edit", branch], root);
  if (!merge.ok) gitQuiet(["merge", "--abort"], root);

  let restoreError = null;
  if (hadLiveChanges) {
    const pop = gitQuiet(["stash", "pop"], root);
    if (!pop.ok) restoreError = withGitDetail(pop.error, pop);
  }

  if (restoreError) {
    return {
      ok: false,
      error: `restoring the stashed live-state changes after the merge attempt conflicted and was left in the stash (resolve manually with 'git stash list' / 'git stash pop'): ${restoreError}`,
    };
  }
  if (!merge.ok) {
    return { ok: false, error: withGitDetail(`merge into main failed: ${merge.error}`, merge) };
  }
  if (!hasStamp(root, codeFingerprint(root, "HEAD"))) {
    gitQuiet(["reset", "--hard", pre], root);
    return { ok: false, error: "merged code has no gate pass (main changed since gating); merge undone" };
  }
  return { ok: true };
}

// The only sanctioned way for automation to push main. The pre-push hook
// re-checks the stamp independently.
export function landPush({ root }) {
  return gitQuiet(["push", "origin", "main"], root);
}
