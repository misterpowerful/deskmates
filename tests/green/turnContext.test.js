import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPersonality, loadActivePersonality, getCapabilitiesBlock, getApprovedInsightsBlock, createStaticBlockCache, resolveVoiceSpeed, SELF_IMPROVE_SECTION_HEADING } from "../../src/turnContext.js";
import { isSelfImproveApproved, isClaudeCodeChatApproved, readConfig } from "../../src/config.js";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnctx-"));
  const pdir = path.join(root, "personalities", "p1");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "personality-breakdown.md"), "PROMPT");
  fs.writeFileSync(path.join(pdir, "voice-config.json"), JSON.stringify({ voice_id: "v1", model: "m1" }));
  fs.writeFileSync(path.join(root, "CAPABILITIES.md"), `# Caps\nbase\n\n${SELF_IMPROVE_SECTION_HEADING}\nsecret\n`);
  fs.writeFileSync(path.join(pdir, "insights.json"), JSON.stringify([
    { status: "approved", insight: "a" },
    { status: "proposed", insight: "b" },
  ]));
  return { root, pdir };
}

test("loadPersonality reads prompt and voice from the given config", () => {
  const { root } = fixture();
  assert.deepEqual(loadPersonality({ active_personality: "p1" }, root), {
    activePersonality: "p1", systemPrompt: "PROMPT", voice_id: "v1", model: "m1", speed: undefined,
  });
});

test("loadPersonality carries through a per-mode speed map", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnctx-speed-"));
  const pdir = path.join(root, "personalities", "p1");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "personality-breakdown.md"), "PROMPT");
  fs.writeFileSync(
    path.join(pdir, "voice-config.json"),
    JSON.stringify({ voice_id: "v1", speed: { friendly: 1.15, bump_complaint: 1.0 } }),
  );
  const { speed } = loadPersonality({ active_personality: "p1" }, root);
  assert.deepEqual(speed, { friendly: 1.15, bump_complaint: 1.0 });
});

test("resolveVoiceSpeed picks the configured mode's speed", () => {
  const speed = { friendly: 1.15, sentry_intruder: 1.0, bump_complaint: 1.0, deep_thoughtful: 1.0 };
  assert.equal(resolveVoiceSpeed(speed, "friendly"), 1.15);
  assert.equal(resolveVoiceSpeed(speed, "sentry_intruder"), 1.0);
});

test("resolveVoiceSpeed falls back to friendly when the mode is undefined (reggie/fergal-style config)", () => {
  const speed = { friendly: 1.1, sentry_intruder: 1.1 };
  assert.equal(resolveVoiceSpeed(speed, "bump_complaint"), 1.1);
  assert.equal(resolveVoiceSpeed(speed, "deep_thoughtful"), 1.1);
});

test("capabilities block gates self-improvement section and is memoized", () => {
  const { root } = fixture();
  const cache = createStaticBlockCache({ root });
  const open = cache.capabilitiesBlock("p1", true);
  const closed = cache.capabilitiesBlock("p1", false);
  assert.ok(open.includes("secret"));
  assert.ok(!closed.includes("secret"));
  assert.ok(closed.startsWith('WHAT YOU CAN DO'));
  assert.equal(cache.capabilitiesBlock("p1", true), open);
  assert.equal(cache.size(), 2);
});

test("cache serves stale-free values: file edit is picked up, personality change clears", () => {
  const { root } = fixture();
  const cache = createStaticBlockCache({ root });
  cache.capabilitiesBlock("p1", true);
  const capsFile = path.join(root, "CAPABILITIES.md");
  fs.writeFileSync(capsFile, "changed\n");
  fs.utimesSync(capsFile, new Date(), new Date(Date.now() + 5000));
  assert.match(cache.capabilitiesBlock("p1", true), /changed/);
  cache.insightsBlock("p1");
  assert.equal(cache.size(), 2);
  cache.insightsBlock("other");
  assert.equal(cache.size(), 1);
});

test("insights block lists only approved insights", () => {
  const { root } = fixture();
  const cache = createStaticBlockCache({ root });
  assert.equal(cache.insightsBlock("p1"), "REFLECTIONS (patterns noticed across long-term memory, approved for use):\n- a");
});

test("loadPersonality memoizes and picks up file edits", () => {
  const { root, pdir } = fixture();
  const cfg = { active_personality: "p1" };
  const first = loadPersonality(cfg, root);
  assert.equal(loadPersonality(cfg, root), first);
  const f = path.join(pdir, "personality-breakdown.md");
  fs.writeFileSync(f, "NEW");
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.equal(loadPersonality(cfg, root).systemPrompt, "NEW");
});

test("shared wrappers read the live repo config", () => {
  const active = readConfig().active_personality;
  assert.equal(loadActivePersonality().activePersonality, active);
  assert.match(getCapabilitiesBlock(true), /^WHAT YOU CAN DO/);
  assert.equal(typeof getApprovedInsightsBlock(active), "string");
});

test("readConfig is cached and frozen, and refreshes when config.json changes", () => {
  assert.equal(readConfig(), readConfig());
  assert.ok(Object.isFrozen(readConfig()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  fs.mkdirSync(path.join(dir, "personalities", "a"), { recursive: true });
  fs.mkdirSync(path.join(dir, "personalities", "b"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ active_personality: "a", x: 1 }));
  const url = pathToFileURL(path.resolve("src/config.js")).href;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const c = await import(${JSON.stringify(url)});
    const first = c.readConfig().active_personality;
    c.setActivePersonality("b");
    const cfg = c.readConfig();
    console.log(JSON.stringify([first, cfg.active_personality, cfg.x]));
  `], { cwd: dir }).toString();
  assert.deepEqual(JSON.parse(out), ["a", "b", 1]);
});

test("isSelfImproveApproved accepts an explicit config", () => {
  assert.equal(isSelfImproveApproved("x", { self_improve_personalities: ["x"] }), true);
});

test("isClaudeCodeChatApproved accepts an explicit config", () => {
  assert.equal(isClaudeCodeChatApproved("pca", { claude_code_chat_personalities: ["pca"] }), true);
  assert.equal(isClaudeCodeChatApproved("gatsby-sardonic", { claude_code_chat_personalities: ["pca"] }), false);
});
