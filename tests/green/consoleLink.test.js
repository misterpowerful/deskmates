import test from "node:test";
import assert from "node:assert/strict";
import { registerConsoleSocket, unregisterConsoleSocket, broadcastToConsoles } from "../../src/consoleLink.js";

function fakeConsole() {
  const sent = [];
  return { ws: { readyState: 1, isConsoleClient: true, send: (m) => sent.push(JSON.parse(m)) }, sent };
}

test("broadcastToConsoles delivers the frame to every registered, open console socket", () => {
  const a = fakeConsole();
  const b = fakeConsole();
  registerConsoleSocket(a.ws);
  registerConsoleSocket(b.ws);
  try {
    const sentCount = broadcastToConsoles({ type: "task_notification", task_id: "t-1", title: "Emails", status: "done" });
    assert.equal(sentCount, 2);
    assert.deepEqual(a.sent[0], { type: "task_notification", task_id: "t-1", title: "Emails", status: "done" });
    assert.deepEqual(b.sent[0], a.sent[0]);
  } finally {
    unregisterConsoleSocket(a.ws);
    unregisterConsoleSocket(b.ws);
  }
});

test("registerConsoleSocket ignores a non-console (physical bot) socket, which never receives a broadcast", () => {
  const bot = { readyState: 1, isConsoleClient: false, send: () => {
    throw new Error("the physical bot must never receive a console broadcast");
  } };
  registerConsoleSocket(bot);
  try {
    assert.doesNotThrow(() => broadcastToConsoles({ type: "task_notification", task_id: "t-2", title: "x", status: "done" }));
  } finally {
    unregisterConsoleSocket(bot);
  }
});

test("unregisterConsoleSocket removes a socket so later broadcasts skip it", () => {
  const a = fakeConsole();
  registerConsoleSocket(a.ws);
  unregisterConsoleSocket(a.ws);
  broadcastToConsoles({ type: "task_notification", task_id: "t-3", title: "x", status: "done" });
  assert.deepEqual(a.sent, []);
});

test("broadcastToConsoles returns 0 and sends nothing when no console is connected", () => {
  assert.equal(broadcastToConsoles({ type: "task_notification", task_id: "t-4", title: "x", status: "done" }), 0);
});
