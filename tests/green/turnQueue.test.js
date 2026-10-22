import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueTurn } from "../../src/turnQueue.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("turns run in arrival order and never overlap", async () => {
  const ws = {};
  const events = [];
  let active = 0;
  const mk = (n, ms) => async () => {
    active++;
    assert.equal(active, 1);
    events.push(`start${n}`);
    await new Promise((r) => setTimeout(r, ms));
    events.push(`end${n}`);
    active--;
    return n;
  };
  const results = await Promise.all([
    enqueueTurn(ws, mk(1, 30)),
    enqueueTurn(ws, mk(2, 1)),
    enqueueTurn(ws, mk(3, 10)),
  ]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(events, ["start1", "end1", "start2", "end2", "start3", "end3"]);
});

test("separate connections do not block each other", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const a = enqueueTurn({}, () => gate);
  const b = await enqueueTurn({}, async () => "b");
  assert.equal(b, "b");
  release();
  await a;
});

test("queue accepts new turns again after draining", async () => {
  const ws = {};
  await enqueueTurn(ws, async () => 1);
  await tick();
  assert.equal(ws.turnQueue.pending, 0);
  assert.equal(await enqueueTurn(ws, async () => 2), 2);
});
