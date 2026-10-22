import test from "node:test";
import assert from "node:assert/strict";
import { isBlankTranscript, noSpeechResult } from "../../src/transcript.js";

test("non-string input is treated as blank, not thrown on", () => {
  for (const t of [0, 5, {}, [], true, NaN]) {
    assert.equal(isBlankTranscript(t), true);
  }
});

test("hostile strings do not get misclassified or hang", () => {
  assert.equal(isBlankTranscript("(" .repeat(100000)), true);
  assert.equal(isBlankTranscript("[" + "a".repeat(100000)), false);
  assert.equal(isBlankTranscript("(a)(b)"), false);
  assert.equal(isBlankTranscript("(silence) hello"), false);
  assert.equal(isBlankTranscript("​"), true);
  assert.equal(noSpeechResult(undefined).kind, "no_speech");
});

test("runSpeechPipeline treats empty, missing and whitespace STT text as no_speech", async () => {
  // speechPipeline builds its API clients at import time; dummy keys, no network.
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  const { runSpeechPipeline } = await import("../../src/speechPipeline.js");
  for (const text of ["", "   \n", undefined, null, "...", "[noise]"]) {
    const stt = { convert: async () => ({ text }) };
    const res = await runSpeechPipeline({}, "friendly", Buffer.alloc(0), {}, stt);
    assert.equal(res.kind, "no_speech");
    assert.equal(res.transcript, text);
  }
});
