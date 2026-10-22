import test from "node:test";
import assert from "node:assert/strict";
import { loadActivePersonality, resolveVoiceSpeed } from "../../src/turnContext.js";

// speechPipeline builds its API clients at import time; dummy keys, no network.
async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("runSpeechPipeline passes the active personality's resolved per-mode speed to the live TTS call", async () => {
  const { runSpeechPipeline } = await loadSpeechPipeline();
  const stt = { convert: async () => ({ text: "hello, nice weather today" }) };
  const createMessage = async () => ({ content: [{ type: "text", text: "Hi there." }], usage: {} });
  const ttsCalls = [];
  const tts = {
    convert: async (voiceId, opts) => {
      ttsCalls.push({ voiceId, opts });
      return Buffer.from([1, 2, 3, 4]);
    },
  };

  const result = await runSpeechPipeline({}, "friendly", Buffer.alloc(4), {}, stt, tts, { createMessage });

  assert.equal(result.kind, "speech");
  assert.equal(ttsCalls.length, 1);
  // Ties the expectation to whatever this checkout's active personality and
  // config actually resolve to, same approach as
  // tests/green/llmSwitcherPipeline.test.js does for the model/thinking wiring
  // — resolveVoiceSpeed's own branches are covered directly in
  // tests/green/turnContext.test.js.
  const { speed } = loadActivePersonality();
  const expected = resolveVoiceSpeed(speed, result.effectiveMode);
  assert.deepEqual(ttsCalls[0].opts.voiceSettings, { speed: expected });
  assert.equal(typeof ttsCalls[0].opts.voiceSettings.speed, "number");
});

test("runSpeechPipeline selects a different speed for a different effective mode", async () => {
  const { runSpeechPipeline } = await loadSpeechPipeline();
  const stt = { convert: async () => ({ text: "ouch, that hurt" }) };
  const createMessage = async () => ({ content: [{ type: "text", text: "Oof." }], usage: {} });
  const ttsCalls = [];
  const tts = {
    convert: async (voiceId, opts) => {
      ttsCalls.push(opts);
      return Buffer.from([1, 2, 3, 4]);
    },
  };

  const result = await runSpeechPipeline({}, "bump_complaint", Buffer.alloc(4), {}, stt, tts, { createMessage });

  const { speed } = loadActivePersonality();
  const expected = resolveVoiceSpeed(speed, "bump_complaint");
  assert.equal(result.effectiveMode, "bump_complaint");
  assert.deepEqual(ttsCalls[0].voiceSettings, { speed: expected });
});
