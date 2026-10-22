import test from "node:test";
import assert from "node:assert/strict";
import { splitForTts, chunkTextToSpeech } from "../../src/ttsChunking.js";

test("non-string, blank and bad limits yield no chunks", () => {
  for (const bad of [null, undefined, 42, {}, "", "   \n "]) assert.deepEqual(splitForTts(bad, 10), []);
  for (const l of [0, -1, 1.5, NaN, "10", undefined]) assert.deepEqual(splitForTts("hello", l), []);
});

test("one giant unbroken token is hard-split under the limit", () => {
  const chunks = splitForTts("x".repeat(1000), 100);
  assert.equal(chunks.length, 10);
  for (const c of chunks) assert.ok(c.length <= 100);
});

test("over-long sentence without punctuation is packed by words", () => {
  const text = "word ".repeat(200).trim() + " and then a giant " + "y".repeat(250) + " end";
  const chunks = splitForTts(text, 60);
  for (const c of chunks) assert.ok(c.length > 0 && c.length <= 60);
  assert.equal(chunks.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("mixed long and short sentences and newlines stay within limit", () => {
  const text = "Hi!\n" + "Long sentence here ".repeat(30) + ". Ok.\n\nBye";
  const chunks = splitForTts(text, 50);
  for (const c of chunks) assert.ok(c.length <= 50);
});

test("blank or missing text is rejected without calling the provider", async () => {
  let called = false;
  const tts = chunkTextToSpeech({
    async convert() {
      called = true;
    },
  });
  for (const req of [{ text: "  ", modelId: "eleven_v3" }, { modelId: "eleven_v3" }, undefined]) {
    await assert.rejects(tts.convert("v", req), /no text/);
  }
  assert.equal(called, false);
});

test("a provider failure mid-reply propagates instead of returning partial audio", async () => {
  let n = 0;
  const tts = chunkTextToSpeech({
    async convert(_v, req) {
      if (++n === 2) throw new Error("provider 500");
      return new Blob([Buffer.from(req.text)]);
    },
  });
  await assert.rejects(
    tts.convert("v", { text: "Long sentence here. ".repeat(400), modelId: "eleven_v3" }),
    /provider 500/,
  );
});

test("a failure in a later chunk propagates even while earlier chunks are still pending", async () => {
  let n = 0;
  const tts = chunkTextToSpeech({
    async convert(_v, req) {
      const isFailing = ++n === 2;
      // Earlier (still-pending) chunks are slower than the one that fails,
      // so the rejection must win instead of the call hanging or resolving.
      await new Promise((resolve) => setTimeout(resolve, isFailing ? 0 : 50));
      if (isFailing) throw new Error("provider 500");
      return new Blob([Buffer.from(req.text)]);
    },
  });
  await assert.rejects(
    tts.convert("v", { text: "Long sentence here. ".repeat(400), modelId: "eleven_v3" }),
    /provider 500/,
  );
});
