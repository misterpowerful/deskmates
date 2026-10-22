import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLM_CHOICES, DEFAULT_LLM, resolveLlm } from "../../src/config.js";
import { PRICES, estimateEquivalentCost } from "../../src/turnLog.js";

test("haiku is the default and carries no thinking param", () => {
  assert.equal(DEFAULT_LLM, "haiku");
  assert.deepEqual(resolveLlm({ active_llm: "haiku" }, "friendly"), {
    model: "claude-haiku-4-5-20251001",
  });
});

test("sonnet-5.5 always carries between_tools thinking, never enabled/adaptive/disabled", () => {
  const r = resolveLlm({ active_llm: "sonnet-5.5" }, "friendly");
  assert.equal(r.model, "claude-sonnet-5-5");
  assert.deepEqual(r.thinking, { type: "between_tools" });
  for (const choice of Object.values(LLM_CHOICES)) {
    if (choice.model === "claude-sonnet-5-5") assert.deepEqual(choice.thinking, { type: "between_tools" });
  }
});

test("the switcher applies to every mode without its own mode_models entry", () => {
  const config = { active_llm: "sonnet-5.5", mode_models: { deep_thoughtful: "claude-sonnet-5" } };
  for (const mode of ["friendly", "sentry_intruder", "bump_complaint"]) {
    assert.equal(resolveLlm(config, mode).model, "claude-sonnet-5-5");
  }
});

test("deep_thoughtful keeps its own explicit model and is unaffected by the switcher", () => {
  const config = { active_llm: "sonnet-5.5", mode_models: { deep_thoughtful: "claude-sonnet-5" } };
  assert.deepEqual(resolveLlm(config, "deep_thoughtful"), { model: "claude-sonnet-5" });
});

test("a leftover mode_models.default does not override the switcher", () => {
  const config = { active_llm: "haiku", mode_models: { default: "claude-sonnet-5" } };
  assert.equal(resolveLlm(config, "friendly").model, "claude-haiku-4-5-20251001");
});

test("sonnet-5.5 has a price entry so turn costs are not logged as $0", () => {
  assert.ok(PRICES["claude-sonnet-5-5"]);
  assert.ok(estimateEquivalentCost("claude-sonnet-5-5", 1000, 100) > 0);
});

test("setActiveLlm writes active_llm and preserves every other key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-llm-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ active_personality: "x", keep: 1 }));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const mod = await import(`../../src/config.js?green=${Date.now()}`);
    const out = mod.setActiveLlm("sonnet-5.5");
    assert.equal(out.active_llm, "sonnet-5.5");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.deepEqual(onDisk, { active_personality: "x", keep: 1, active_llm: "sonnet-5.5" });
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("haiku-5.5 resolves to Claude Haiku 5.5 with no thinking param, and is priced", () => {
  assert.deepEqual(resolveLlm({ active_llm: "haiku-5.5" }, "friendly"), { model: "claude-haiku-5-5" });
  assert.equal(LLM_CHOICES["haiku-5.5"].label, "Haiku 5.5");
  assert.ok(estimateEquivalentCost("claude-haiku-5-5", 1_000_000, 0) > 0);
});
