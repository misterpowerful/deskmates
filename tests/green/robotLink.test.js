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
  const sent = [];
  return { ws: { readyState: 1, isConsoleClient: false, send: (m) => sent.push(JSON.parse(m)) }, sent };
}

test("a command that gets its robot_result before the timeout never fires the timeout handler", async () => {
  const { ws } = fakeBot();
  registerRobotSocket(ws);
  const timedOut = [];
  setRobotCommandTimeoutHandler((w, id) => timedOut.push(id));
  try {
    const id = sendRobotCommand("summon", 20);
    assert.ok(id);
    const entry = takeRobotCommand(id);
    assert.equal(entry.action, "summon");
    await wait(60);
    assert.deepEqual(timedOut, []);
  } finally {
    unregisterRobotSocket(ws);
    setRobotCommandTimeoutHandler(null);
  }
});

test("a command that never gets a robot_result times out, is removed from pending, and fires the timeout handler with the original ws", async () => {
  const { ws } = fakeBot();
  registerRobotSocket(ws);
  let firedWith = null;
  setRobotCommandTimeoutHandler((w, id, entry) => {
    firedWith = { w, id, entry };
  });
  try {
    const id = sendRobotCommand("summon", 20);
    await wait(60);
    assert.ok(firedWith);
    assert.equal(firedWith.id, id);
    assert.equal(firedWith.w, ws);
    assert.equal(firedWith.entry.action, "summon");
    // Already consumed by the timeout — a late/duplicate robot_result finds nothing.
    assert.equal(takeRobotCommand(id), null);
  } finally {
    unregisterRobotSocket(ws);
    setRobotCommandTimeoutHandler(null);
  }
});

test("unregisterRobotSocket on the bot's connection reconciles its still-pending command before the timer ever fires", async () => {
  const { ws } = fakeBot();
  registerRobotSocket(ws);
  const timedOut = [];
  setRobotCommandTimeoutHandler((w, id) => timedOut.push(id));
  try {
    const id = sendRobotCommand("summon", 20);
    unregisterRobotSocket(ws);
    await wait(60);
    assert.deepEqual(timedOut, []);
    assert.equal(takeRobotCommand(id), null);
  } finally {
    setRobotCommandTimeoutHandler(null);
  }
});

test("describeRobotResult and buildRobotAnnouncementReport cover the synthetic timeout outcome in plain English", () => {
  const description = describeRobotResult({ outcome: "timeout" });
  assert.match(description, /contact with the robot was lost/);
  assert.match(description, /the owner/);

  const report = buildRobotAnnouncementReport({ outcome: "timeout", action: "summon" });
  assert.match(report, /Robot report, not something the owner said/);
  assert.match(report, /contact with the robot was lost/);
  assert.match(report, /React to the owner in one short spoken line, in character/);
});

test("buildRobotAnnouncementReport for a real found/not_found robot_result matches describeRobotResult's wording", () => {
  const msg = { outcome: "found", owner_recognized: true };
  const report = buildRobotAnnouncementReport(msg);
  assert.ok(report.includes(describeRobotResult(msg)));
});

test("sendOrQueueBotFrame sends immediately when a bot is connected, and does not queue it", () => {
  const { ws, sent } = fakeBot();
  registerRobotSocket(ws);
  try {
    const delivered = sendOrQueueBotFrame({ type: "task_done", task_id: "t-1" });
    assert.equal(delivered, true);
    assert.deepEqual(sent, [{ type: "task_done", task_id: "t-1" }]);
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("sendOrQueueBotFrame queues when no bot is connected, then flushes in order once one reconnects", () => {
  const delivered = sendOrQueueBotFrame({ type: "task_done", task_id: "t-a" });
  assert.equal(delivered, false);
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-b" });

  const { ws, sent } = fakeBot();
  registerRobotSocket(ws);
  try {
    assert.deepEqual(sent, [
      { type: "task_done", task_id: "t-a" },
      { type: "task_done", task_id: "t-b" },
    ]);
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("a queued frame older than maxAgeMs is dropped instead of firing once the bot reconnects", async () => {
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-stale" }, { maxAgeMs: 5 });
  await wait(30);
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-fresh" });

  const { ws, sent } = fakeBot();
  registerRobotSocket(ws, { maxAgeMs: 5 });
  try {
    assert.deepEqual(sent, [{ type: "task_done", task_id: "t-fresh" }]);
  } finally {
    unregisterRobotSocket(ws);
  }
});

test("the queue is capped at maxCount, dropping the oldest frames first", () => {
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-1" }, { maxCount: 2 });
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-2" }, { maxCount: 2 });
  sendOrQueueBotFrame({ type: "task_done", task_id: "t-3" }, { maxCount: 2 });

  const { ws, sent } = fakeBot();
  registerRobotSocket(ws, { maxCount: 2 });
  try {
    assert.deepEqual(sent, [
      { type: "task_done", task_id: "t-2" },
      { type: "task_done", task_id: "t-3" },
    ]);
  } finally {
    unregisterRobotSocket(ws);
  }
});
