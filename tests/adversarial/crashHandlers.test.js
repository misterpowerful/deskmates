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

test("non-Error rejection values are logged safely", () => {
  for (const v of ["str", { a: 1 }, null, undefined, 42]) {
    const { proc, logs, exits } = setup();
    proc.emit("unhandledRejection", v);
    assert.deepEqual(exits, [1]);
    assert.match(logs[0], /non-Error value/);
  }
});

test("circular value does not break logging", () => {
  const { proc, logs, exits } = setup();
  const o = {}; o.self = o;
  proc.emit("uncaughtException", o);
  assert.deepEqual(exits, [1]);
  assert.match(logs[0], /non-Error value/);
});

test("Error without stack still logs", () => {
  const { proc, logs } = setup();
  const e = new Error("x"); e.stack = "";
  proc.emit("uncaughtException", e);
  assert.match(logs[0], /Error: x/);
});

test("throwing getContext or logger never prevents exit", () => {
  const a = setup({ getContext: () => { throw new Error("ctx"); } });
  a.proc.emit("uncaughtException", new Error("e"));
  assert.deepEqual(a.exits, [1]);
  assert.match(a.logs[0], /context unavailable/);
  const b = setup({ log: () => { throw new Error("log"); } });
  b.proc.emit("uncaughtException", new Error("e"));
  assert.deepEqual(b.exits, [1]);
});

test("repeated crashes exit only once", () => {
  const { proc, exits } = setup();
  proc.emit("uncaughtException", new Error("1"));
  proc.emit("unhandledRejection", new Error("2"));
  assert.equal(exits.length, 1);
});
