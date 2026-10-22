import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gateRulesForPrompt } from "../../scripts/lib/gate.js";

test("the shared prompt rules name both suites and the discard rule", () => {
  const rules = gateRulesForPrompt();
  assert.match(rules, /tests\/green/);
  assert.match(rules, /tests\/adversarial/);
  assert.match(rules, /3 rounds/);
});

test("the spec document exists", () => {
  assert.ok(fs.existsSync("TESTING-GATE.md"));
});
