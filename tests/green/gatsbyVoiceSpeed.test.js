import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveVoiceSpeed } from "../../src/turnContext.js";

// Gatsby's pace is set by the owner: 1.0 (ElevenLabs' natural pace) in every mode
// (2026-10-17). 1.15 sounded rushed on long reads; the self-built 0.85 was
// far too slow. Reads the real on-disk config, same file production reads.
const configPath = path.join("personalities", "gatsby-sardonic", "voice-config.json");
const GATSBY_SPEED = 1.0;

test("Gatsby speaks at the natural 1.0 pace in every known mode", () => {
  const { speed } = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const mode of ["friendly", "sentry_intruder", "bump_complaint", "deep_thoughtful"]) {
    assert.equal(resolveVoiceSpeed(speed, mode), GATSBY_SPEED, mode);
  }
});

test("the voice itself is untouched by the speed setting", () => {
  const { voice_id } = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(voice_id, "iOaeOfjw5WOFoce6tLnY");
});
