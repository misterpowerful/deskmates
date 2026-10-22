import test from "node:test";
import assert from "node:assert/strict";
import { startStream, appendStreamChunk, endStream, cancelStream } from "../../src/speechStream.js";

test("chunks sent between start and end come back as one utterance, in order", () => {
  const ws = {};
  assert.equal(startStream(ws, { id: "s-1", mode: "friendly" }), null);
  assert.equal(appendStreamChunk(ws, Buffer.from([1, 2])), true);
  assert.equal(appendStreamChunk(ws, new Uint8Array([3, 4, 5, 6])), true);
  const result = endStream(ws, "s-1");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "friendly");
  assert.equal(result.raw, false);
  assert.deepEqual([...result.audio], [1, 2, 3, 4, 5, 6]);
  assert.equal(ws.audioStream, null);
});

test("binary frames with no open stream are left for the one-shot path", () => {
  assert.equal(appendStreamChunk({}, Buffer.from([1])), false);
});

test("cancel drops the open stream and its audio", () => {
  const ws = {};
  startStream(ws, { id: "s-2", mode: "friendly" });
  appendStreamChunk(ws, Buffer.from([1, 2]));
  assert.equal(cancelStream(ws, "s-2"), true);
  assert.equal(endStream(ws, "s-2").ok, false);
});
