import test from "node:test";
import assert from "node:assert/strict";
import {
  registerRobotSocket,
  unregisterRobotSocket,
  sendRobotCommand,
  takeRobotCommand,
  setRobotCommandTimeoutHandler,
  describeRobotResult,
  buildRobotAnnouncementReport,
  sendOrQueueBotFrame,
} from "../../src/robotLink.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBot() {
  return { readyState: 1, isConsoleClient: false, send: () => {} };
}

function fakeBotCapture() {
  const sent = [];
  return { ws: { readyState: 1, isConsoleClient: false, send: (m) => sent.push(JSON.parse(m)) }, sent };
}

test("takeRobotCommand on an unknown/garbage id fails safely instead of throwing", () => {
  for (const id of [undefined, null, "", "not-a-real-id", 12345, {}, ["r-x-1"]]) {
    assert.doesNotThrow(() => takeRobotCommand(id));
    assert.equal(takeRobotCommand(id), null);
  }
});

test("a command timing out with no handler ever registered is still cleaned up instead of throwing", async () => {
  const ws = fakeBot();
  registerRobotSocket(ws);
  setRobotCommandTimeoutHandler(null);
  try {
    const id = sendRobotCommand("summon", 20);
    await wait(60);
    assert.equal(takeRobotCommand(id), null);
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("a timeout handler that throws is contained: the pending entry is still reclaimed and the process doesn't crash", async () => {
  const ws = fakeBot();
  registerRobotSocket(ws);
  setRobotCommandTimeoutHandler(() => {
    throw new Error("boom from a hostile/buggy handler");
  });
  try {
    const id = sendRobotCommand("summon", 20);
    await wait(60);
    assert.equal(takeRobotCommand(id), null);
  } finally {
    unregisterRobotSocket(ws);
    setRobotCommandTimeoutHandler(null);
  }
});

test("unregisterRobotSocket for an unrelated socket does not touch another socket's still-pending command", async () => {
  const botA = fakeBot();
  const botB = fakeBot();
  registerRobotSocket(botA);
  const timedOut = [];
  setRobotCommandTimeoutHandler((w, id) => timedOut.push(id));
  try {
    const idA = sendRobotCommand("summon", 40);
    // botB was never registered as the connected bot, so this command landed on botA.
    unregisterRobotSocket(botB);
    await wait(10);
    // Still pending — unrelated unregister must not have reconciled it early.
    assert.notEqual(takeRobotCommand(idA), null);
  } finally {
    unregisterRobotSocket(botA);
    setRobotCommandTimeoutHandler(null);
  }
});

test("unregisterRobotSocket reconciles every pending command tied to that socket, not just one", async () => {
  const ws = fakeBot();
  registerRobotSocket(ws);
  const timedOut = [];
  setRobotCommandTimeoutHandler((w, id) => timedOut.push(id));
  try {
    const id1 = sendRobotCommand("summon", 30);
    const id2 = sendRobotCommand("summon", 30);
    assert.notEqual(id1, id2);
    unregisterRobotSocket(ws);
    assert.equal(takeRobotCommand(id1), null);
    assert.equal(takeRobotCommand(id2), null);
    await wait(60);
    assert.deepEqual(timedOut, []);
  } finally {
    setRobotCommandTimeoutHandler(null);
  }
});

test("double unregisterRobotSocket on the same socket does not throw", () => {
  const ws = fakeBot();
  registerRobotSocket(ws);
  unregisterRobotSocket(ws);
  assert.doesNotThrow(() => unregisterRobotSocket(ws));
});

test("a robot_result arriving after takeRobotCommand already consumed it (duplicate/out-of-order frame) returns null the second time", async () => {
  const ws = fakeBot();
  registerRobotSocket(ws);
  try {
    const id = sendRobotCommand("summon", 500);
    assert.notEqual(takeRobotCommand(id), null);
    assert.equal(takeRobotCommand(id), null);
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("describeRobotResult and buildRobotAnnouncementReport fail safe on malformed/hostile outcome values", () => {
  for (const outcome of [undefined, null, "", 123, {}, ["x"], "<script>alert(1)</script>"]) {
    assert.doesNotThrow(() => describeRobotResult({ outcome }));
    assert.doesNotThrow(() => buildRobotAnnouncementReport({ outcome }));
    const description = describeRobotResult({ outcome });
    assert.equal(typeof description, "string");
    assert.ok(description.length > 0);
  }
  assert.doesNotThrow(() => describeRobotResult({}));
});

test("queuing far more than the cap during a long simulated outage never grows the queue past maxCount", () => {
  for (let i = 0; i < 500; i++) {
    sendOrQueueBotFrame({ type: "task_done", task_id: `t-${i}` }, { maxCount: 5 });
  }
  const { ws, sent } = fakeBotCapture();
  registerRobotSocket(ws, { maxCount: 5 });
  try {
    // Oldest-first eviction: only the last 5 of the 500 ever queued survive.
    assert.equal(sent.length, 5);
    assert.deepEqual(
      sent.map((f) => f.task_id),
      [495, 496, 497, 498, 499].map((i) => `t-${i}`),
    );
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("garbage maxAgeMs/maxCount options (NaN, negative, Infinity, strings, objects) fail safe instead of throwing or disabling the cap", () => {
  const garbageOptions = [
    { maxAgeMs: NaN, maxCount: NaN },
    { maxAgeMs: -1, maxCount: -1 },
    { maxAgeMs: Infinity, maxCount: Infinity },
    { maxAgeMs: "not-a-number", maxCount: "also-not-a-number" },
    { maxAgeMs: {}, maxCount: [] },
    { maxAgeMs: null, maxCount: null },
  ];
  let i = 0;
  for (const options of garbageOptions) {
    for (let j = 0; j < 10; j++) {
      assert.doesNotThrow(() => sendOrQueueBotFrame({ type: "task_done", task_id: `t-${i}` }, options));
      i++;
    }
  }
  // 60 frames queued, each push applying a garbage limit that should fall
  // back to the real default cap (50) rather than disabling it: only the
  // last 50 pushed can have survived.
  const { ws, sent } = fakeBotCapture();
  registerRobotSocket(ws);
  try {
    assert.equal(sent.length, 50);
    assert.deepEqual(
      sent.map((f) => f.task_id),
      Array.from({ length: 50 }, (_, k) => `t-${k + 10}`),
    );
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("maxAgeMs of 0 drops every already-queued frame on the next flush instead of firing it", async () => {
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-old" });
  await wait(5);
  const { ws, sent } = fakeBotCapture();
  registerRobotSocket(ws, { maxAgeMs: 0 });
  try {
    assert.deepEqual(sent, []);
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("re-registering the same socket twice in a row (out-of-order connect/flush) does not double-send a queued frame", () => {
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-once" });
  const { ws, sent } = fakeBotCapture();
  registerRobotSocket(ws);
  registerRobotSocket(ws);
  try {
    assert.deepEqual(sent, [{ type: "task_done", task_id: "t-once" }]);
  } finally {
    unregisterRobotSocket(ws);
  }
});
