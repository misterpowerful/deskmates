import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPersonality, createStaticBlockCache, resolveVoiceSpeed } from "../../src/turnContext.js";
import { isSelfImproveApproved, isClaudeCodeChatApproved, readConfig, setActivePersonality } from "../../src/config.js";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "turnctx-adv-"));

test("loadPersonality throws for unknown personality or malformed voice config", () => {
  const root = tmp();
  assert.throws(() => loadPersonality({ active_personality: "nope" }, root));
  const d = path.join(root, "personalities", "bad");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "personality-breakdown.md"), "x");
  fs.writeFileSync(path.join(d, "voice-config.json"), "{not json");
  assert.throws(() => loadPersonality({ active_personality: "bad" }, root));
});

test("missing CAPABILITIES.md and missing/malformed insights yield empty blocks", () => {
  const root = tmp();
  const cache = createStaticBlockCache({ root });
  assert.equal(cache.capabilitiesBlock("p", true), "");
  assert.equal(cache.insightsBlock("p"), "");
  const d = path.join(root, "personalities", "p");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "insights.json"), "{\"a\":1}");
  assert.equal(cache.insightsBlock("p"), "");
  fs.writeFileSync(path.join(d, "insights.json"), "garbage");
  fs.utimesSync(path.join(d, "insights.json"), new Date(), new Date(Date.now() + 5000));
  assert.equal(cache.insightsBlock("p"), "");
  fs.writeFileSync(path.join(d, "insights.json"), JSON.stringify([null, { status: "proposed" }]));
  fs.utimesSync(path.join(d, "insights.json"), new Date(), new Date(Date.now() + 9000));
  assert.equal(cache.insightsBlock("p"), "");
});

test("hostile personality names and non-boolean approval never share entries unsafely", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "CAPABILITIES.md"), "a\n## Self-improvement pipeline\nb\n");
  const cache = createStaticBlockCache({ root });
  assert.equal(cache.insightsBlock("../../etc"), "");
  assert.ok(!cache.capabilitiesBlock("p", undefined).includes("b\n"));
  assert.ok(cache.capabilitiesBlock("p", 1).includes("Self-improvement"));
});

test("isSelfImproveApproved fails closed on malformed config", () => {
  assert.equal(isSelfImproveApproved("x", {}), false);
  assert.equal(isSelfImproveApproved("x", { self_improve_personalities: "x" }), false);
});

test("isClaudeCodeChatApproved fails closed on malformed config", () => {
  assert.equal(isClaudeCodeChatApproved("x", {}), false);
  assert.equal(isClaudeCodeChatApproved("x", { claude_code_chat_personalities: "x" }), false);
});

test("readConfig fails loudly on malformed config and the shared object rejects mutation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-adv-"));
  fs.writeFileSync(path.join(dir, "config.json"), "{bad");
  const url = pathToFileURL(path.resolve("src/config.js")).href;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e",
    `const c = await import(${JSON.stringify(url)}); c.readConfig();`], { cwd: dir, stdio: "pipe" }));
  assert.throws(() => { readConfig().active_personality = "evil"; }, TypeError);
});

test("setActivePersonality rejects unknown names without touching config", () => {
  assert.throws(() => setActivePersonality("../nope"), /unknown personality/);
});

test("resolveVoiceSpeed never returns undefined/NaN/non-numeric, no matter how malformed speed is", () => {
  assert.equal(resolveVoiceSpeed(undefined, "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed(null, "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed({}, "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed("1.15", "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed(42, "friendly"), 1.0);
  // mode entry present but non-numeric (hostile/malformed config) falls back
  assert.equal(resolveVoiceSpeed({ friendly: "fast" }, "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed({ friendly: "fast", bump_complaint: 1.2 }, "friendly"), 1.0);
  // missing/unknown mode key (reggie/fergal only define a subset) falls back to friendly, not undefined
  assert.equal(resolveVoiceSpeed({ friendly: 1.1 }, "bump_complaint"), 1.1);
  assert.equal(resolveVoiceSpeed({ friendly: 1.1 }, "__proto__"), 1.1);
  assert.equal(resolveVoiceSpeed({ friendly: 1.1 }, undefined), 1.1);
  // a 0 speed is a deliberately configured value, not treated as missing
  assert.equal(resolveVoiceSpeed({ friendly: 0 }, "friendly"), 0);
});
