import test from "node:test";
import assert from "node:assert/strict";
import { runGate } from "../../scripts/lib/gate.js";
import { makeFixture } from "../helpers/fixtureRepo.js";

test("the real gate passes a change that adds code with tests in both suites", async () => {
  const f = makeFixture();
  f.write("src/a.js", "export const a = 1;\nexport function inc(n) {\n  return n + 1;\n}\n");
  f.write("tests/green/a.test.js", f.testFile('test("inc adds one", () => assert.equal(a.inc(1), 2));'));
  f.write("tests/adversarial/a.test.js", f.testFile('test("inc tolerates junk input", () => assert.doesNotThrow(() => a.inc(undefined)));'));
  const res = await runGate(f.dir, { baseRef: "main", boot: false });
  assert.deepEqual(res.failures, []);
  assert.equal(res.passed, true);
  assert.deepEqual(res.stages.map((s) => s.stage), ["syntax", "test-presence", "test-ratchet", "test:green", "test:adversarial", "coverage"]);
});

test("a behavior-preserving change passes without new tests when presence is off", async () => {
  const f = makeFixture();
  f.write("src/a.js", "// reworded comment only\nexport const a = 1;\n");
  f.write("tests/green/a.test.js", f.testFile('test("a is 1", () => assert.equal(a.a, 1));'));
  f.write("tests/adversarial/a.test.js", f.testFile('test("a is a number", () => assert.equal(typeof a.a, "number"));'));
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "tests");
  f.git("branch", "-f", "base");
  f.write("src/a.js", "// another comment\nexport const a = 1;\n");
  const res = await runGate(f.dir, { baseRef: "base", boot: false, requireTests: false });
  assert.equal(res.passed, true);
});
