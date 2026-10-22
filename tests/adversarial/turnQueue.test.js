import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueTurn, TurnQueueFullError } from "../../src/turnQueue.js";

test("a throwing turn does not stall later turns", async () => {
  const ws = {};
  const order = [];
  const a = enqueueTurn(ws, async () => {
    throw new Error("boom");
  });
  const b = enqueueTurn(ws, async () => {
    order.push("b");
    return "b";
  });
  const c = enqueueTurn(ws, () => {
    throw new Error("sync boom");
  });
  const d = enqueueTurn(ws, async () => "d");
  await assert.rejects(a, /boom/);
  assert.equal(await b, "b");
  await assert.rejects(c, /sync boom/);
  assert.equal(await d, "d");
  assert.deepEqual(order, ["b"]);
});

test("backlog cap rejects overflow without running it", async () => {
  const ws = {};
  let release;
  const gate = new Promise((r) => (release = r));
  const ran = [];
  const p = [enqueueTurn(ws, async () => (await gate, ran.push(0)))];
  for (let i = 1; i <= 3; i++) p.push(enqueueTurn(ws, async () => ran.push(i)));
  const over = enqueueTurn(ws, async () => ran.push("over"));
  await assert.rejects(over, TurnQueueFullError);
  release();
  await Promise.all(p);
  assert.deepEqual(ran, [0, 1, 2, 3]);
});

test("custom cap of 0 rejects anything while a turn is running", async () => {
  const ws = {};
  let release;
  const gate = new Promise((r) => (release = r));
  const a = enqueueTurn(ws, () => gate, 0);
  await assert.rejects(enqueueTurn(ws, async () => 1, 0), /busy, try again/);
  release();
  await a;
});
