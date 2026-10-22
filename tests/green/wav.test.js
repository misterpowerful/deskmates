import test from "node:test";
import assert from "node:assert/strict";
import { wrapPcmAsWav } from "../../src/wav.js";

test("wraps PCM with a correct 44-byte WAV header", () => {
  const pcm = Buffer.alloc(320, 1);
  const wav = wrapPcmAsWav(pcm);
  assert.equal(wav.length, 44 + 320);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(4), 36 + 320);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 320);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("honors custom sample rate, channels and bit depth", () => {
  const wav = wrapPcmAsWav(Buffer.alloc(8), { sampleRate: 44100, channels: 2, bitDepth: 16 });
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt32LE(28), 44100 * 4);
  assert.equal(wav.readUInt16LE(32), 4);
});
