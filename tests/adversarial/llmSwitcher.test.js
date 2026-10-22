import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLlm } from "../../src/config.js";

const HAIKU = "claude-haiku-4-5-20251001";

test("missing/null/wrong-type config falls back to haiku without throwing", () => {
  for (const config of [undefined, null, {}, { active_llm: null }, { active_llm: 5 }, { active_llm: {} }, { active_llm: [] }]) {
    assert.equal(resolveLlm(config, "friendly").model, HAIKU);
  }
});

test("unknown, prototype-pollution and path-ish active_llm values fall back to haiku", () => {
  for (const bad of ["gpt-5", "", " haiku", "HAIKU", "__proto__", "constructor", "toString", "../haiku", "sonnet-5.5\n"]) {
    assert.equal(resolveLlm({ active_llm: bad }, "friendly").model, HAIKU);
  }
});

test("a bad mode_models shape cannot override the switcher or inject a thinking param", () => {
  for (const mode_models of [null, [], "x", { friendly: 5 }, { friendly: null }, { friendly: { model: "x" } }]) {
    const r = resolveLlm({ active_llm: "haiku", mode_models }, "friendly");
    assert.equal(r.model, HAIKU);
    assert.equal(r.thinking, undefined);
  }
});

test("hostile effectiveMode values do not crash or pick a polluted model", () => {
  for (const mode of ["__proto__", "constructor", "toString", "", undefined, null, 42]) {
    assert.equal(resolveLlm({ active_llm: "haiku", mode_models: {} }, mode).model, HAIKU);
  }
});

test("the returned thinking object is frozen so a caller can't mutate the shared choice", () => {
  const r = resolveLlm({ active_llm: "sonnet-5.5" }, "friendly");
  assert.throws(() => {
    "use strict";
    r.thinking.type = "enabled";
  });
  assert.equal(resolveLlm({ active_llm: "sonnet-5.5" }, "friendly").thinking.type, "between_tools");
});

test("setActiveLlm rejects unknown names, leaves config.json untouched, and ignores prototype keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-llm-adv-"));
  const original = JSON.stringify({ active_llm: "haiku" });
  fs.writeFileSync(path.join(dir, "config.json"), original);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const mod = await import(`../../src/config.js?adv=${Date.now()}`);
    for (const bad of ["gpt-5", "", undefined, null, 7, "__proto__", "constructor", "sonnet-5.5-thinking", "sonnet-5"]) {
      assert.throws(() => mod.setActiveLlm(bad), /unknown llm/);
    }
    assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), original);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
