import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installCrashHandlers } from "../../src/crashHandlers.js";

function setup(opts = {}) {
  const proc = new EventEmitter();
  const logs = [];
  const exits = [];
  installCrashHandlers({ proc, log: (m) => logs.push(m), exit: (c) => exits.push(c), ...opts });
  return { proc, logs, exits };
}

test("uncaughtException logs stack and context then exits 1", () => {
  const { proc, logs, exits } = setup({ getContext: () => ({ activeConnections: 3 }) });
  const err = new Error("boom");
  proc.emit("uncaughtException", err);
  assert.equal(exits[0], 1);
  assert.match(logs[0], /uncaughtException/);
  assert.ok(logs[0].includes(err.stack));
  assert.match(logs[0], /"activeConnections":3/);
});

test("unhandledRejection logs and exits 1", () => {
  const { proc, logs, exits } = setup();
  proc.emit("unhandledRejection", new Error("rej"));
  assert.deepEqual(exits, [1]);
  assert.match(logs[0], /unhandledRejection/);
});

test("default options install on the real process without firing", () => {
  const before = process.listenerCount("uncaughtException");
  installCrashHandlers();
  assert.equal(process.listenerCount("uncaughtException"), before + 1);
  const ls = process.listeners("uncaughtException");
  process.removeListener("uncaughtException", ls[ls.length - 1]);
  const lr = process.listeners("unhandledRejection");
  process.removeListener("unhandledRejection", lr[lr.length - 1]);
});
