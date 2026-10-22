import test from "node:test";
import assert from "node:assert/strict";
import { startStream, appendStreamChunk, endStream, cancelStream, MAX_STREAM_BYTES } from "../../src/speechStream.js";

test("a stream that grows past the cap is refused at the end instead of buffered forever", () => {
  const ws = {};
  startStream(ws, { id: "s-big", mode: "friendly" });
  assert.equal(appendStreamChunk(ws, Buffer.alloc(MAX_STREAM_BYTES)), true);
  assert.equal(appendStreamChunk(ws, Buffer.alloc(2)), true); // consumed but dropped
  assert.equal(ws.audioStream.bytes, MAX_STREAM_BYTES);
  const result = endStream(ws, "s-big");
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeded/);
});

test("ending a stream with the wrong id, none open, or no audio fails cleanly", () => {
  const ws = {};
  assert.equal(endStream(ws, "s-x").ok, false);
  startStream(ws, { id: "s-3", mode: "friendly" });
  assert.equal(endStream(ws, "s-other").ok, false);
  assert.equal(ws.audioStream.id, "s-3", "a wrong-id end must not close the real stream");
  const empty = endStream(ws, "s-3");
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no audio/);
});

test("a new start replaces a stream that was never ended, and reports it", () => {
  const ws = {};
  startStream(ws, { id: "s-4", mode: "friendly" });
  appendStreamChunk(ws, Buffer.from([9, 9]));
  assert.equal(startStream(ws, { id: "s-5", mode: "friendly", raw: 1 }), "s-4");
  appendStreamChunk(ws, Buffer.from([7]));
  const result = endStream(ws, "s-5");
  assert.equal(result.raw, true);
  assert.deepEqual([...result.audio], [7]);
});

test("cancel with a mismatched id leaves the open stream alone; cancel with no stream is a no-op", () => {
  const ws = {};
  assert.equal(cancelStream(ws), false);
  startStream(ws, { id: "s-6", mode: "friendly" });
  assert.equal(cancelStream(ws, "s-7"), false);
  assert.equal(ws.audioStream.id, "s-6");
  assert.equal(cancelStream(ws), true);
});
