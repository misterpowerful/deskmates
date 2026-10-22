import test from "node:test";
import assert from "node:assert/strict";
import { startLiveTranscriber } from "../../src/liveStt.js";
import { fakeConnect } from "../helpers/fakeLiveStt.js";

test("a refused connection, a server error, or a commit that never answers all resolve to null (batch fallback)", async () => {
  assert.equal(await startLiveTranscriber({ connect: fakeConnect({ failConnect: true }).connect }).finish(500), null);
  assert.equal(await startLiveTranscriber({ connect: fakeConnect({ emitError: true }).connect }).finish(500), null);
  const t0 = Date.now();
  const stuck = startLiveTranscriber({ connect: fakeConnect({ neverCommit: true }).connect });
  stuck.push(Buffer.from("hi"));
  assert.equal(await stuck.finish(150), null);
  assert.ok(Date.now() - t0 < 1000, "the timeout bounds the wait");
});

test("a session that opens too slowly, an empty transcript, and pushes after close never hang or throw", async () => {
  assert.equal(await startLiveTranscriber({ connect: fakeConnect({ sessionDelayMs: 500 }).connect }).finish(100), null);
  const empty = startLiveTranscriber({ connect: fakeConnect().connect });
  assert.equal(await empty.finish(500), null, "no audio -> no transcript");
  const fake = fakeConnect();
  const live = startLiveTranscriber({ connect: fake.connect });
  live.close();
  live.close();
  live.push(Buffer.from("late"));
  assert.deepEqual(fake.sent, []);
});

test("an empty or missing live transcript falls back to the batch transcription", async () => {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  const { runSpeechPipeline } = await import("../../src/speechPipeline.js");
  let batchCalls = 0;
  const stt = { convert: async () => { batchCalls += 1; return { text: "from batch" }; } };
  const tts = { convert: async () => new Blob([Buffer.alloc(4)]).stream() };
  const createMessage = async () => ({ content: [{ type: "text", text: "Indeed." }], usage: {} });
  for (const liveTranscript of [null, "", "   "]) {
    const result = await runSpeechPipeline({}, "friendly", Buffer.alloc(32), {}, stt, tts, { createMessage, liveTranscript });
    assert.equal(result.transcript, "from batch");
  }
  assert.equal(batchCalls, 3);
});

test("a failing socket write, a failing commit, or a dropped connection fall back instead of throwing", async () => {
  const writeFails = startLiveTranscriber({ connect: fakeConnect({ sendThrows: true }).connect });
  writeFails.push(Buffer.from("hello"));
  assert.equal(await writeFails.finish(500), null);

  const commitFails = startLiveTranscriber({ connect: fakeConnect({ commitThrows: true }).connect });
  commitFails.push(Buffer.from("hello"));
  assert.equal(await commitFails.finish(500), null);

  const dropped = startLiveTranscriber({ connect: fakeConnect({ dropAfterStart: true }).connect });
  await new Promise((r) => setTimeout(r, 20));
  dropped.push(Buffer.from("hello"));
  assert.equal(await dropped.finish(500), null);
});
