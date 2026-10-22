import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveVoiceSpeed } from "../../src/turnContext.js";

const configPath = path.join("personalities", "gatsby-sardonic", "voice-config.json");

test("hostile/unknown modes against Gatsby's real speed map fall back to his friendly pace, never something extreme", () => {
  const { speed } = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const mode of ["__proto__", "constructor", "", "FRIENDLY", "nonsense_mode", 123, null, undefined, {}]) {
    const resolved = resolveVoiceSpeed(speed, mode);
    assert.equal(resolved, speed.friendly, `mode=${JSON.stringify(mode)}`);
    assert.ok(resolved >= 0.9 && resolved <= 1.1, `mode=${JSON.stringify(mode)} resolved to ${resolved}`);
  }
});

test("a malformed voice-config.json (missing/non-object speed) still fails safe, independent of Gatsby's tuned values", () => {
  assert.equal(resolveVoiceSpeed(undefined, "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed("0.85", "friendly"), 1.0);
  assert.equal(resolveVoiceSpeed({ friendly: "slow" }, "friendly"), 1.0);
});
