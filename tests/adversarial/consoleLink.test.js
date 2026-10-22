import test from "node:test";
import assert from "node:assert/strict";
import { registerConsoleSocket, unregisterConsoleSocket, broadcastToConsoles } from "../../src/consoleLink.js";

test("registerConsoleSocket fails safe on garbage input instead of throwing", () => {
  for (const bad of [null, undefined, {}, "not a socket", 42, []]) {
    assert.doesNotThrow(() => registerConsoleSocket(bad));
    assert.doesNotThrow(() => unregisterConsoleSocket(bad));
  }
});

test("a console socket that throws on send is skipped, logged, and doesn't stop the rest of the broadcast", () => {
  const sent = [];
  const throwing = { readyState: 1, isConsoleClient: true, send: () => { throw new Error("socket exploded"); } };
  const healthy = { readyState: 1, isConsoleClient: true, send: (m) => sent.push(JSON.parse(m)) };
  registerConsoleSocket(throwing);
  registerConsoleSocket(healthy);
  try {
    let sentCount;
    assert.doesNotThrow(() => {
      sentCount = broadcastToConsoles({ type: "task_notification", task_id: "t-hostile", title: "x", status: "done" });
    });
    assert.equal(sentCount, 1);
    assert.equal(sent.length, 1);
  } finally {
    unregisterConsoleSocket(throwing);
    unregisterConsoleSocket(healthy);
  }
});

test("a closing/closed console socket (readyState !== 1) is skipped rather than sent to", () => {
  const sent = [];
  const closing = { readyState: 2, isConsoleClient: true, send: (m) => sent.push(m) };
  registerConsoleSocket(closing);
  try {
    const sentCount = broadcastToConsoles({ type: "task_notification", task_id: "t-closing", title: "x", status: "done" });
    assert.equal(sentCount, 0);
    assert.deepEqual(sent, []);
  } finally {
    unregisterConsoleSocket(closing);
  }
});

test("broadcastToConsoles fails safe (no throw, returns 0) for a frame that can't be serialized", () => {
  const circular = { type: "task_notification" };
  circular.self = circular;
  const sent = [];
  const healthy = { readyState: 1, isConsoleClient: true, send: (m) => sent.push(m) };
  registerConsoleSocket(healthy);
  try {
    let sentCount;
    assert.doesNotThrow(() => {
      sentCount = broadcastToConsoles(circular);
    });
    assert.equal(sentCount, 0);
    assert.deepEqual(sent, []);
  } finally {
    unregisterConsoleSocket(healthy);
  }
});

test("double-registering and double-unregistering the same socket doesn't throw or double-send", () => {
  const sent = [];
  const ws = { readyState: 1, isConsoleClient: true, send: (m) => sent.push(m) };
  registerConsoleSocket(ws);
  registerConsoleSocket(ws);
  try {
    broadcastToConsoles({ type: "task_notification", task_id: "t-dup", title: "x", status: "done" });
    assert.equal(sent.length, 1);
  } finally {
    unregisterConsoleSocket(ws);
    assert.doesNotThrow(() => unregisterConsoleSocket(ws));
  }
});
