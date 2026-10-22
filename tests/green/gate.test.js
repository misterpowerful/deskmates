import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseTapFailures,
  fingerprintFailure,
  OscillationTracker,
  countTestCalls,
  checkTestPresence,
  checkRatchet,
  runFixLoop,
  codeFingerprint,
  stampPass,
  hasStamp,
  hasTrackedChanges,
  landMerge,
  checkRootOnMain,
  gitFailureDetail,
  MAX_ROUNDS,
  REPEAT_LIMIT,
} from "../../scripts/lib/gate.js";
import { makeTmpRepo } from "../helpers/tmp.js";

const fake = (results) => {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
};
const F = (stage, id) => ({ stage, id, message: "boom" });
const fail = (...failures) => ({ passed: false, failures, stages: [] });
const pass = { passed: true, failures: [], stages: [] };

test("defaults match the spec", () => {
  assert.equal(MAX_ROUNDS, 8);
  assert.equal(REPEAT_LIMIT, 3);
});

test("parseTapFailures extracts failing test names and messages", () => {
  const tap = "ok 1 - fine\nnot ok 2 - it breaks\n  ---\n  error: 'expected 1'\n  ...\n";
  assert.deepEqual(parseTapFailures(tap), [{ id: "it breaks", message: "expected 1" }]);
});

test("countTestCalls counts test and it calls", () => {
  assert.equal(countTestCalls('test("a", () => {});\n  it("b", () => {});\ntest.each("c")'), 3);
});

test("test presence is satisfied when both suites change alongside source", () => {
  assert.deepEqual(checkTestPresence(["src/a.js", "tests/green/a.test.js", "tests/adversarial/a.test.js"]), []);
  assert.deepEqual(checkTestPresence(["README.md", "webapp/src/App.vue"]), []);
});

test("ratchet passes when counts hold or grow", () => {
  assert.deepEqual(checkRatchet({ green: 3, adversarial: 3 }, { green: 4, adversarial: 3 }, []), []);
});

test("fix loop returns clean on the first passing round", async () => {
  const r = await runFixLoop({ cwd: ".", gate: fake([pass]), fix: async () => {} });
  assert.equal(r.outcome, "clean");
  assert.equal(r.rounds.length, 1);
});

test("fix loop fixes a failure and then goes clean", async () => {
  let fixes = 0;
  const r = await runFixLoop({ cwd: ".", gate: fake([fail(F("test:green", "a")), pass]), fix: async () => void fixes++ });
  assert.equal(r.outcome, "clean");
  assert.equal(fixes, 1);
});

test("the tracker trips only when a fingerprint reaches the repeat limit", () => {
  const t = new OscillationTracker({ repeatLimit: 3 });
  assert.equal(t.record([F("test:green", "a")]), null);
  assert.equal(t.record([F("test:green", "a")]), null);
  assert.equal(t.record([F("test:green", "a")]).count, 3);
});

test("code fingerprint ignores tasks/ and logs/ but tracks code; stamps are keyed on it", () => {
  const { dir, git } = makeTmpRepo();
  const before = codeFingerprint(dir);
  fs.mkdirSync(path.join(dir, "tasks"));
  fs.writeFileSync(path.join(dir, "tasks", "t.md"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", "task");
  assert.equal(codeFingerprint(dir), before);
  assert.equal(hasStamp(dir, before), false);
  stampPass(dir);
  assert.equal(hasStamp(dir, before), true);
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 2;\n");
  git("commit", "-q", "-am", "change");
  assert.notEqual(codeFingerprint(dir), before);
  assert.equal(hasStamp(dir, codeFingerprint(dir)), false);
});

test("fingerprints of test failures are keyed by stage and test name", () => {
  assert.equal(fingerprintFailure(F("test:green", "x")), "test:green|x");
});

import { parseLcov, mergeCoverage, parseAddedLines, findUncoveredAdded, isCodeLine, requiresCoverage } from "../../scripts/lib/gate.js";

test("lcov is parsed and merged across suites", () => {
  const a = parseLcov("SF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record\n");
  const b = parseLcov("SF:src/a.js\nDA:1,0\nDA:2,3\nend_of_record\n");
  const merged = mergeCoverage([a, b]);
  assert.equal(merged.get("src/a.js").get(2), 3);
  assert.equal(merged.get("src/a.js").get(1), 1);
});

test("added lines are read from a zero-context diff", () => {
  const diff = "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -3,0 +4,2 @@\n+const x = 1;\n+// note\n";
  assert.deepEqual(parseAddedLines(diff).get("src/a.js"), [
    { line: 4, text: "const x = 1;" },
    { line: 5, text: "// note" },
  ]);
});

test("covered added code passes; comments and closers are not code", () => {
  const added = new Map([["src/a.js", [{ line: 1, text: "run();" }, { line: 2, text: "// c" }, { line: 3, text: "}" }]]]);
  const cov = new Map([["src/a.js", new Map([[1, 4]])]]);
  assert.deepEqual(findUncoveredAdded(added, cov), []);
  assert.equal(isCodeLine("  // comment"), false);
  assert.equal(isCodeLine("  return 1;"), true);
});

test("presence can be turned off for behavior-preserving jobs", () => {
  assert.deepEqual(checkTestPresence(["src/a.js"], { require: false }), []);
});

test("coverage is enforced for library code, not entry points", () => {
  assert.equal(requiresCoverage("src/a.js"), true);
  assert.equal(requiresCoverage("scripts/lib/gate.js"), true);
  assert.equal(requiresCoverage("scripts/run-cleanup.js"), false);
  assert.equal(requiresCoverage("server.js"), false);
});

test("hasTrackedChanges finds tracked modifications and ignores untracked files", () => {
  assert.equal(hasTrackedChanges(" M src/a.js\n?? scratch.txt\n"), true);
  assert.equal(hasTrackedChanges("?? only/untracked.txt\n"), false);
  assert.equal(hasTrackedChanges(""), false);
});

test("landMerge stashes a live-state edit, merges, and restores the edit on top", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  stampPass(dir);
  git("checkout", "-q", "main");

  // Simulates config.json being rewritten on disk by the live process,
  // with no corresponding commit, while the nightly merge runs.
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'live-edit';\n");

  const res = landMerge({ root: dir, branch: "feature" });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "src", "a.js"), "utf8"), "export const a = 'live-edit';\n");
  assert.equal(fs.readFileSync(path.join(dir, "src", "b.js"), "utf8"), "export const b = 1;\n");
  assert.match(git("status", "--porcelain"), /src\/a\.js/);
  assert.equal(git("stash", "list"), "");
});

test("checkRootOnMain passes when the live checkout is on main", () => {
  const { dir } = makeTmpRepo();
  assert.deepEqual(checkRootOnMain(dir), { ok: true });
});

test("landMerge surfaces git's actual conflict detail, not just the generic command-failed message", () => {
  const { dir, git } = makeTmpRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'feature';\n");
  git("commit", "-q", "-am", "feature changes a.js");
  stampPass(dir);
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 'main';\n");
  git("commit", "-q", "-am", "main diverges on a.js");

  const res = landMerge({ root: dir, branch: "feature" });
  assert.equal(res.ok, false);
  assert.match(res.error, /merge into main failed/);
  assert.match(res.error, /CONFLICT/);
  assert.match(res.error, /src\/a\.js/);
});

test("gitFailureDetail surfaces git's diagnostic output", () => {
  const detail = gitFailureDetail({
    output: "Auto-merging src/a.js\nCONFLICT (content): Merge conflict in src/a.js\n",
    stderr: "",
  });
  assert.match(detail, /CONFLICT \(content\): Merge conflict in src\/a\.js/);
});
