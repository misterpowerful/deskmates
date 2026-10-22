import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseTapFailures,
  fingerprintFailure,
  normalizeMessage,
  OscillationTracker,
  countTestCalls,
  findSkipMarkers,
  checkTestPresence,
  checkRatchet,
  runFixLoop,
  describeGateOutcome,
  writeGateFailure,
  hasStamp,
  stampPass,
  codeFingerprint,
  landMerge,
  hasTrackedChanges,
  checkRootOnMain,
  gitFailureDetail,
  withGitDetail,
} from "../../scripts/lib/gate.js";
import { makeTmpRepo, makeTmpDir } from "../helpers/tmp.js";

const fake = (results) => {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
};
const F = (stage, id, message = "boom") => ({ stage, id, message });
const fail = (...failures) => ({ passed: false, failures, stages: [] });
const pass = { passed: true, failures: [], stages: [] };

test("green fixed -> adversarial breaks -> green breaks again: the third recurrence aborts", async () => {
  // Round 1: green fails. Round 2: adversarial fails. Round 3: green again. Round 4: adversarial. Round 5: green (3rd).
  const G = F("test:green", "parses config");
  const A = F("test:adversarial", "rejects garbage config");
  let fixes = 0;
  const r = await runFixLoop({ cwd: ".", gate: fake([fail(G), fail(A), fail(G), fail(A), fail(G), pass]), fix: async () => void fixes++ });
  assert.equal(r.outcome, "oscillation");
  assert.equal(r.tripped.fingerprint, "test:green|parses config");
  assert.equal(r.tripped.count, 3);
  assert.equal(r.rounds.length, 5);
  assert.equal(fixes, 4);
  assert.match(describeGateOutcome(r), /oscillation/);
});

test("the same single failure three rounds running also aborts", async () => {
  const r = await runFixLoop({ cwd: ".", gate: fake([fail(F("syntax", "a.js"))]), fix: async () => {} });
  assert.equal(r.outcome, "oscillation");
  assert.equal(r.rounds.length, 3);
});

test("ever-changing distinct failures hit the backstop, not oscillation", async () => {
  let n = 0;
  const gate = async () => fail(F("test:green", `t${n++}`));
  const r = await runFixLoop({ cwd: ".", gate, fix: async () => {}, maxRounds: 4 });
  assert.equal(r.outcome, "backstop");
  assert.equal(r.rounds.length, 4);
});

test("a throwing fixer aborts the loop cleanly", async () => {
  const r = await runFixLoop({
    cwd: ".",
    gate: fake([fail(F("test:green", "a"))]),
    fix: async () => {
      throw new Error("claude timed out");
    },
  });
  assert.equal(r.outcome, "fixer_error");
  assert.match(describeGateOutcome(r), /claude timed out/);
});

test("the fix prompt warns when a failure is one round from the limit", async () => {
  const prompts = [];
  await runFixLoop({ cwd: ".", gate: fake([fail(F("test:green", "a"))]), fix: async (p) => void prompts.push(p) });
  assert.doesNotMatch(prompts[0], /ONE more/);
  assert.match(prompts[1], /ONE more/);
});

test("fingerprints are stable across numbers, paths and whitespace", () => {
  const a = fingerprintFailure({ stage: "boot", message: "port 12345 failed at /tmp/x/abc:12" });
  const b = fingerprintFailure({ stage: "boot", message: "port  999 failed   at /var/y/zzz:7" });
  assert.equal(a, b);
  assert.equal(normalizeMessage(undefined), "");
  assert.ok(normalizeMessage("x".repeat(10_000)).length <= 200);
});

test("tracker counts a fingerprint once per round even if it repeats within a round", () => {
  const t = new OscillationTracker({ repeatLimit: 3 });
  assert.equal(t.record([F("test:green", "a"), F("test:green", "a"), F("test:green", "a")]), null);
});

test("parseTapFailures tolerates garbage, empty and huge input", () => {
  assert.deepEqual(parseTapFailures(""), []);
  assert.deepEqual(parseTapFailures(null), []);
  assert.deepEqual(parseTapFailures("\0\0not ok\nnot ok - \n"), []);
  assert.equal(parseTapFailures("not ok 1 - x\n".repeat(5000)).length, 5000);
});

test("skip/todo/only markers are detected; test calls are counted despite indentation", () => {
  // Built at runtime so this file's own source doesn't contain the markers the ratchet scans for.
  const dot = (a, b) => [a, b].join(".");
  const opt = (k, v) => `{ ${k}: ${v} }`;
  assert.equal(findSkipMarkers(dot("test", "skip") + '("a")'), true);
  assert.equal(findSkipMarkers(dot("describe", "only") + '("a")'), true);
  assert.equal(findSkipMarkers(dot("it", "todo") + '("a")'), true);
  assert.equal(findSkipMarkers('test("a", ' + opt("sk" + "ip", "true") + ", () => {})"), true);
  assert.equal(findSkipMarkers('test("a", ' + opt("sk" + "ip", "false") + ", () => {})"), false);
  assert.equal(findSkipMarkers('test("skips nothing", () => {})'), false);
  assert.equal(countTestCalls('   \t test("a", f)\n// test("commented")\nit ("b", f)'), 2);
});

test("source changes without tests in both suites are rejected, one at a time", () => {
  assert.equal(checkTestPresence(["src/a.js"]).length, 2);
  assert.equal(checkTestPresence(["server.js", "tests/green/a.test.js"]).length, 1);
  assert.equal(checkTestPresence(["scripts/x.js", "tests/adversarial/a.test.js"]).length, 1);
  assert.equal(checkTestPresence(["tests/green/only-tests.test.js"]).length, 0);
  assert.equal(checkTestPresence(["src/a.js", "tests/green/a.txt", "tests/adversarial/b.md"]).length, 2);
});

test("removing tests or adding skips fails the ratchet", () => {
  assert.equal(checkRatchet({ green: 5, adversarial: 5 }, { green: 4, adversarial: 5 }, []).length, 1);
  assert.equal(checkRatchet({ green: 5, adversarial: 5 }, { green: 5, adversarial: 5 }, ["tests/green/a.test.js"]).length, 1);
  assert.equal(checkRatchet({}, {}, []).length, 0);
});

test("stamps cannot be forged with traversal or malformed fingerprints", () => {
  const { dir } = makeTmpRepo();
  for (const fp of ["../../etc/passwd", "", "abc", "g".repeat(64), "a".repeat(63), undefined, null]) {
    assert.equal(hasStamp(dir, fp), false);
  }
});

test("writeGateFailure records rounds and caps the discarded diff", () => {
  const root = makeTmpDir();
  const loop = { outcome: "oscillation", rounds: [{ round: 1 }], tripped: { fingerprint: "f", count: 3 } };
  const rel = writeGateFailure({ root, stamp: "s", job: "j", subject: "x", loop, diff: "d".repeat(500_000) });
  const data = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  assert.equal(data.outcome, "oscillation");
  assert.equal(data.discardedDiff.length, 200_000);
});

test("landMerge refuses ungated code and leaves main where it was", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  git("checkout", "-q", "main");
  const before = git("rev-parse", "HEAD");
  const res = landMerge({ root: dir, branch: "feature" });
  assert.equal(res.ok, false);
  assert.match(res.error, /no gate pass/);
  assert.equal(git("rev-parse", "HEAD"), before);
});

test("landMerge accepts a branch whose code was stamped", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  stampPass(dir);
  git("checkout", "-q", "main");
  assert.equal(landMerge({ root: dir, branch: "feature" }).ok, true);
});

test("hasTrackedChanges tolerates garbage, empty and non-string input", () => {
  assert.equal(hasTrackedChanges(null), false);
  assert.equal(hasTrackedChanges(undefined), false);
  assert.equal(hasTrackedChanges(12345), true);
  assert.equal(hasTrackedChanges("\0\0garbage\n"), true);
  assert.equal(hasTrackedChanges("??\n??\n"), false);
});

test("landMerge restores a live-state edit even when the merge itself fails", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'feature';\n");
  git("commit", "-q", "-am", "feature changes a.js");
  stampPass(dir);
  git("checkout", "-q", "main");
  // main diverges on the same file so the merge itself conflicts, independent of any live edit.
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'main';\n");
  git("commit", "-q", "-am", "main diverges on a.js");

  fs.writeFileSync(path.join(dir, "src", "live.js"), "placeholder\n");
  git("add", "-A");
  git("commit", "-q", "-m", "add live-state file");
  fs.writeFileSync(path.join(dir, "src", "live.js"), "live-edit\n");

  const before = git("rev-parse", "HEAD");
  const res = landMerge({ root: dir, branch: "feature" });
  assert.equal(res.ok, false);
  assert.match(res.error, /merge into main failed/);
  assert.match(res.error, /CONFLICT/);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(dir, "src", "live.js"), "utf8"), "live-edit\n");
  assert.equal(git("stash", "list"), "");
});

test("landMerge fails clearly, without silently dropping work, when restoring a live-state edit conflicts", () => {
  const { dir, git } = makeTmpRepo();
  fs.writeFileSync(path.join(dir, "src", "a.js"), "line1\nline2\nline3\n");
  git("commit", "-q", "-am", "multi-line base");
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "line1\nFEATURE\nline3\n");
  git("commit", "-q", "-am", "feature changes line2");
  stampPass(dir);
  git("checkout", "-q", "main");
  // A live edit to the same line the merge brings in: popping the stash afterward conflicts.
  fs.writeFileSync(path.join(dir, "src", "a.js"), "line1\nLIVE\nline3\n");

  const res = landMerge({ root: dir, branch: "feature" });
  assert.equal(res.ok, false);
  assert.match(res.error, /conflicted and was left in the stash/);
  assert.match(git("stash", "list"), /\S/);
});

test("landMerge fails clearly when it cannot stash live-state edits before merging", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  stampPass(dir);
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'live-edit';\n");

  // An index.lock mimics another git process already holding the lock.
  const lockPath = path.join(dir, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  try {
    const res = landMerge({ root: dir, branch: "feature" });
    assert.equal(res.ok, false);
    assert.match(res.error, /could not stash/);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test("gitFailureDetail tolerates missing, empty, and non-string stdout/stderr without crashing", () => {
  assert.equal(gitFailureDetail({}), "");
  assert.equal(gitFailureDetail({ output: null, stderr: undefined }), "");
  assert.equal(gitFailureDetail({ output: "", stderr: "" }), "");
  assert.equal(gitFailureDetail(null), "");
  assert.equal(gitFailureDetail(undefined), "");
  assert.equal(gitFailureDetail({ output: 0, stderr: false }), "0\nfalse");
});

test("gitFailureDetail truncates oversized git output instead of growing the failure note unbounded", () => {
  const detail = gitFailureDetail({ output: "x".repeat(50000), stderr: "" });
  assert.ok(detail.length < 4100);
  assert.match(detail, /\[truncated\]$/);
});

test("withGitDetail falls back to the bare message when there is no git result to draw detail from", () => {
  assert.equal(withGitDetail("merge into main failed: Command failed: git merge", undefined), "merge into main failed: Command failed: git merge");
  assert.equal(withGitDetail("merge into main failed: boom", { output: "", stderr: "" }), "merge into main failed: boom");
});

test("landMerge fails clearly when it cannot stash, even if git gives no stdout/stderr detail", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  stampPass(dir);
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'live-edit';\n");

  const lockPath = path.join(dir, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  try {
    const res = landMerge({ root: dir, branch: "feature" });
    assert.equal(res.ok, false);
    assert.match(res.error, /could not stash/);
    assert.equal(typeof res.error, "string");
    assert.ok(res.error.length > 0);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test("the pre-push hook check blocks unstamped code and allows stamped or bookkeeping-only pushes", () => {
  const { dir, git, env } = makeTmpRepo();
  const script = path.resolve("scripts/gate-check.js");
  const run = (sha, remoteSha = "0".repeat(40)) =>
    spawnSync("node", [script, "pre-push"], { cwd: dir, env, input: `refs/heads/main ${sha} refs/heads/main ${remoteSha}\n`, encoding: "utf8" });

  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'bad';\n");
  git("commit", "-q", "-am", "unvetted change");
  const bad = git("rev-parse", "HEAD");
  const blocked = run(bad, base);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /GATE: refusing/);

  fs.mkdirSync(path.join(dir, "tasks"));
  fs.writeFileSync(path.join(dir, "tasks", "n.md"), "n");
  git("add", "-A");
  git("commit", "-q", "-m", "bookkeeping");
  assert.equal(run(git("rev-parse", "HEAD"), base).status, 1, "still carries the unvetted code change");

  stampPass(dir);
  assert.equal(run(git("rev-parse", "HEAD"), base).status, 0);
  assert.equal(run("0".repeat(40), base).status, 0, "branch deletion is allowed");
  assert.equal(codeFingerprint(dir, base) !== codeFingerprint(dir, "HEAD"), true);
});

import { parseLcov, parseAddedLines, findUncoveredAdded, mergeCoverage } from "../../scripts/lib/gate.js";

test("added code with a zero hit count fails coverage and names the lines", () => {
  const added = new Map([["src/a.js", [{ line: 7, text: "doThing();" }, { line: 8, text: "other();" }]]]);
  const cov = new Map([["src/a.js", new Map([[7, 0], [8, 2]])]]);
  const failures = findUncoveredAdded(added, cov);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "coverage");
  assert.match(failures[0].message, /7/);
});

test("a source file no test loads counts as fully uncovered", () => {
  const added = new Map([["src/new.js", [{ line: 1, text: "export const x = 1;" }]]]);
  const failures = findUncoveredAdded(added, new Map());
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /no test loads/);
});

test("entry-point files and comment-only additions are never flagged", () => {
  assert.deepEqual(findUncoveredAdded(new Map([["scripts/run-x.js", [{ line: 1, text: "main();" }]]]), new Map()), []);
  assert.deepEqual(findUncoveredAdded(new Map([["src/a.js", [{ line: 1, text: "// only a comment" }, { line: 2, text: "" }]]]), new Map()), []);
});

test("removal-only diffs add nothing to cover", () => {
  const diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -5,3 +4,0 @@\n-old();\n-old2();\n-old3();\n";
  assert.equal(parseAddedLines(diff).size, 0);
  assert.equal(parseAddedLines("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n").size, 0);
});

test("garbage lcov and diffs do not throw", () => {
  assert.equal(parseLcov(null).size, 0);
  assert.equal(parseLcov("DA:1,1\nSF:\nDA:x,y\n").size, 1);
  assert.equal(parseAddedLines(undefined).size, 0);
  assert.equal(mergeCoverage([]).size, 0);
});

test("removing or skipping tests stops the loop immediately for human review", async () => {
  let fixes = 0;
  const ratchet = { passed: false, failures: [{ stage: "test-ratchet", message: "tests/green/ went from 5 to 4 tests." }], stages: [] };
  const r = await runFixLoop({ cwd: ".", gate: fake([ratchet]), fix: async () => void fixes++ });
  assert.equal(r.outcome, "needs_review");
  assert.equal(fixes, 0);
  assert.match(describeGateOutcome(r), /human review/);
});

test("checkRootOnMain reports the real branch and refuses to proceed when ROOT isn't on main", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "speech-streaming");
  const res = checkRootOnMain(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /speech-streaming/);
  assert.match(res.error, /not main/);
  assert.doesNotMatch(res.error, /merge into main failed/);
});

test("checkRootOnMain fails safely (no throw) when root is not a git repo at all", () => {
  const dir = makeTmpDir();
  const res = checkRootOnMain(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /could not determine/);
});

test("checkRootOnMain honors a custom baseRef instead of always demanding 'main'", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "release");
  assert.equal(checkRootOnMain(dir, "release").ok, true);
  assert.equal(checkRootOnMain(dir, "main").ok, false);
});

test("gate options reach the gate function", async () => {
  let seen;
  await runFixLoop({ cwd: ".", gateOptions: { requireTests: false }, gate: async (cwd, o) => ((seen = o), pass), fix: async () => {} });
  assert.equal(seen.requireTests, false);
});
