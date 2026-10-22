import test from "node:test";
import assert from "node:assert/strict";
import { splitForTts, ttsCharLimit, chunkTextToSpeech } from "../../src/ttsChunking.js";

test("short text is a single chunk", () => {
  assert.deepEqual(splitForTts("Hello there.", 100), ["Hello there."]);
});

test("long text splits on sentence boundaries within the limit", () => {
  const text = "One fine sentence. Two fine sentence. Three fine sentence.";
  const chunks = splitForTts(text, 40);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 40);
  assert.equal(chunks.join(" "), text);
});

test("deep_thoughtful-sized reply fits every model's limit after splitting", () => {
  const text = "A considered sentence about things. ".repeat(500);
  for (const model of ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "unknown"]) {
    const limit = ttsCharLimit(model);
    const chunks = splitForTts(text, limit);
    for (const c of chunks) assert.ok(c.length <= limit);
    assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.trim().replace(/\s+/g, " "));
  }
});

test("limits: known models and conservative default", () => {
  assert.equal(ttsCharLimit("eleven_v3"), 4500);
  assert.equal(ttsCharLimit("eleven_flash_v2_5"), 36000);
  assert.equal(ttsCharLimit("nope"), 4500);
});

const fakeTts = (seen) => ({
  async convert(voiceId, req) {
    seen.push({ voiceId, ...req });
    return new Blob([Buffer.from(req.text)]);
  },
});
const run = async (tts, req) =>
  Buffer.from(await new Response(await tts.convert("v", req)).arrayBuffer());

test("short reply is one request, passed through with its options", async () => {
  const seen = [];
  const tts = chunkTextToSpeech(fakeTts(seen));
  const audio = await run(tts, { text: "Aaa. Bbb.", modelId: "eleven_v3", outputFormat: "pcm_16000" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].voiceId, "v");
  assert.equal(seen[0].outputFormat, "pcm_16000");
  assert.equal(audio.toString(), "Aaa. Bbb.");
});

test("over-limit reply makes several requests, joined into one audio", async () => {
  const text = "Sentence number one is here. ".repeat(400);
  const seen = [];
  const tts = chunkTextToSpeech(fakeTts(seen));
  const audio = await run(tts, { text, modelId: "eleven_v3", outputFormat: "pcm_16000" });
  assert.ok(seen.length >= 3);
  for (const r of seen) assert.ok(r.text.length <= 4500);
  assert.equal(audio.length, seen.reduce((n, r) => n + r.text.length, 0));
  assert.equal(audio.toString(), seen.map((r) => r.text).join(""));
});

test("chunk requests are dispatched concurrently, not one-at-a-time", async () => {
  const text = "Sentence number one is here. ".repeat(400);
  let inFlight = 0;
  let maxInFlight = 0;
  const tts = chunkTextToSpeech({
    async convert(voiceId, req) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Blob([Buffer.from(req.text)]);
    },
  });
  await run(tts, { text, modelId: "eleven_v3" });
  assert.ok(maxInFlight >= 3, `expected overlap between chunk requests, got max ${maxInFlight}`);
});

test("final audio stays in original chunk order even when later chunks resolve first", async () => {
  const text = "Sentence number one is here. ".repeat(400);
  const seen = [];
  const tts = chunkTextToSpeech({
    async convert(voiceId, req) {
      const index = seen.length;
      seen.push(req.text);
      // Earlier chunks resolve later than subsequent ones, regardless of chunk count.
      await new Promise((resolve) => setTimeout(resolve, (100 - index) * 2));
      return new Blob([Buffer.from(req.text)]);
    },
  });
  const audio = await run(tts, { text, modelId: "eleven_v3" });
  assert.equal(audio.toString(), seen.join(""));
});
