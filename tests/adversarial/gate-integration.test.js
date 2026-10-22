import test from "node:test";
import assert from "node:assert/strict";
import { runGate } from "../../scripts/lib/gate.js";
import { makeFixture } from "../helpers/fixtureRepo.js";

const stagesFailed = (res) => [...new Set(res.failures.map((x) => x.stage))].sort();

function withBothSuites(f, { green = 'test("a is 1", () => assert.equal(a.a, 1));', adversarial = 'test("a is a number", () => assert.equal(typeof a.a, "number"));' } = {}) {
  f.write("tests/green/a.test.js", f.testFile(green));
  f.write("tests/adversarial/a.test.js", f.testFile(adversarial));
}

test("added code that no test executes fails the coverage stage", async () => {
  const f = makeFixture();
  f.write("src/a.js", "export const a = 1;\nexport function neverCalled() {\n  return 42;\n}\n");
  withBothSuites(f);
  const res = await runGate(f.dir, { baseRef: "main", boot: false });
  assert.equal(res.passed, false);
  assert.deepEqual(stagesFailed(res), ["coverage"]);
  assert.match(res.failures[0].message, /not exercised/);
});

test("a failing test is reported by suite and test name", async () => {
  const f = makeFixture();
  f.write("src/a.js", "export const a = 1;\n// touched\n");
  withBothSuites(f, { green: 'test("a is 2", () => assert.equal(a.a, 2));' });
  const res = await runGate(f.dir, { baseRef: "main", boot: false });
  assert.equal(res.passed, false);
  const failure = res.failures.find((x) => x.stage === "test:green");
  assert.equal(failure.id, "a is 2");
});

test("source changes without a test in one suite fail test-presence", async () => {
  const f = makeFixture();
  f.write("src/a.js", "export const a = 1;\n// touched\n");
  f.write("tests/green/a.test.js", f.testFile('test("a is 1", () => assert.equal(a.a, 1));'));
  const res = await runGate(f.dir, { baseRef: "main", boot: false });
  assert.ok(stagesFailed(res).includes("test-presence"));
  assert.ok(res.failures.some((x) => /tests\/adversarial/.test(x.message)));
});

test("removing a test trips the ratchet", async () => {
  const f = makeFixture();
  withBothSuites(f);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "tests");
  f.write("tests/green/a.test.js", f.testFile("// emptied"));
  f.write("src/a.js", "export const a = 1;\n// touched\n");
  f.write("tests/adversarial/b.test.js", f.testFile('test("extra", () => assert.ok(a));'));
  const res = await runGate(f.dir, { baseRef: "main", boot: false });
  assert.ok(stagesFailed(res).includes("test-ratchet"));
});

test("a syntax error is caught before anything runs", async () => {
  const f = makeFixture();
  f.write("src/a.js", "export const a = ;\n");
  withBothSuites(f);
  const res = await runGate(f.dir, { baseRef: "main", boot: false });
  assert.ok(stagesFailed(res).includes("syntax"));
});
