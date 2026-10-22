import test from "node:test";
import assert from "node:assert/strict";
import { startLiveTranscriber } from "../../src/liveStt.js";
import { fakeConnect } from "../helpers/fakeLiveStt.js";

test("audio pushed before the session starts is buffered and sent in order; finish returns the transcript", async () => {
  const fake = fakeConnect({ sessionDelayMs: 20 });
  const live = startLiveTranscriber({ connect: fake.connect });
  live.push(Buffer.from("what's on "));
  live.push(new Uint8Array(Buffer.from("my agenda")));
  await new Promise((r) => setTimeout(r, 40));
  live.push(Buffer.from(" today"));
  assert.equal(await live.finish(1000), "what's on my agenda today");
});

test("the speech pipeline uses a live transcript and skips the batch upload", async () => {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  const { runSpeechPipeline } = await import("../../src/speechPipeline.js");
  let batchCalls = 0;
  const stt = { convert: async () => { batchCalls += 1; return { text: "batch" }; } };
  const tts = { convert: async () => new Blob([Buffer.alloc(4)]).stream() };
  const createMessage = async () => ({ content: [{ type: "text", text: "Indeed." }], usage: {} });
  const timings = {};
  const result = await runSpeechPipeline({}, "friendly", Buffer.alloc(32), timings, stt, tts, { createMessage, liveTranscript: "hello there" });
  assert.equal(batchCalls, 0);
  assert.equal(result.transcript, "hello there");
  assert.equal(timings.sttLive, true);
});

test("the real connection is opened with the batch path's English pin and wake-word keyterms", async () => {
  const { defaultConnect } = await import("../../src/liveStt.js");
  let opts;
  const fakeClient = { speechToText: { realtime: { connect: async (o) => ((opts = o), "conn") } } };
  assert.equal(await defaultConnect(fakeClient), "conn");
  assert.equal(opts.modelId, "scribe_v2_realtime");
  assert.equal(opts.audioFormat, "pcm_16000");
  assert.equal(opts.sampleRate, 16000);
  assert.equal(opts.languageCode, "en");
  assert.deepEqual(opts.keyterms, ["Gatsby", "Hey Gatsby"]);
});
