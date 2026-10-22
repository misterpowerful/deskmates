import test from "node:test";
import assert from "node:assert/strict";
import { isBlankTranscript, noSpeechResult } from "../../src/transcript.js";

test("blank and tag-only transcripts are flagged", () => {
  for (const t of [null, undefined, "", "   ", "\n\t", "...", "-", "(silence)", "[noise]", "(background noise)", " [ Music ] "]) {
    assert.equal(isBlankTranscript(t), true, JSON.stringify(t));
  }
});

test("real short utterances pass through", () => {
  for (const t of ["no", "hi", "ok", "Hi there", "42", "What is (this)?", "yes (please)"]) {
    assert.equal(isBlankTranscript(t), false, t);
  }
});

test("noSpeechResult returns the short-circuit result or null", () => {
  assert.deepEqual(noSpeechResult("(silence)"), { kind: "no_speech", transcript: "(silence)" });
  assert.equal(noSpeechResult("hello"), null);
});

test("runSpeechPipeline short-circuits a blank transcript without Claude, TTS or memory", async () => {
  // speechPipeline builds its API clients at import time; dummy keys, no network.
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  const { runSpeechPipeline } = await import("../../src/speechPipeline.js");
  const { getTurns } = await import("../../src/sessionMemory.js");
  const ws = {};
  const timings = {};
  const stt = { convert: async () => ({ text: "(silence)" }) };
  const res = await runSpeechPipeline(ws, "friendly", Buffer.alloc(4), timings, stt);
  assert.deepEqual(res, { kind: "no_speech", transcript: "(silence)" });
  assert.equal(typeof timings.stt, "number");
  assert.deepEqual(getTurns(ws), []);
});
