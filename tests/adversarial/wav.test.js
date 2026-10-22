import test from "node:test";
import assert from "node:assert/strict";
import { wrapPcmAsWav } from "../../src/wav.js";

test("empty PCM still yields a valid header", () => {
  const wav = wrapPcmAsWav(Buffer.alloc(0));
  assert.equal(wav.length, 44);
  assert.equal(wav.readUInt32LE(4), 36);
  assert.equal(wav.readUInt32LE(40), 0);
});

test("does not mutate or alias the input buffer", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = wrapPcmAsWav(pcm);
  wav[44] = 99;
  assert.equal(pcm[0], 1);
});

test("odd-length and large buffers keep sizes consistent", () => {
  for (const n of [1, 3, 1_000_001]) {
    const wav = wrapPcmAsWav(Buffer.alloc(n));
    assert.equal(wav.readUInt32LE(40), n);
    assert.equal(wav.length, 44 + n);
  }
});

test("non-buffer input is rejected rather than producing garbage", () => {
  assert.throws(() => wrapPcmAsWav(null));
  assert.throws(() => wrapPcmAsWav(undefined));
});

test("absurd format options do not throw a range error for valid 16-bit values, and invalid ones throw", () => {
  assert.doesNotThrow(() => wrapPcmAsWav(Buffer.alloc(2), { sampleRate: 8000, channels: 1, bitDepth: 8 }));
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(2), { sampleRate: -1 }));
});
