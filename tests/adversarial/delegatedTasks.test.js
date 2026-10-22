import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DELEGATED_TASKS_DIR,
  ensureDelegatedTasksDir,
  createDelegatedTask,
  readTask,
  listTasks,
  getTaskResult,
  matchExplicitDelegate,
  parseWorkerOutput,
  spawnClaudeWorker,
  scrubAnthropicEnv,
  sweepRetention,
  reconcileOrphanedTasks,
  DelegateTaskError,
} from "../../src/delegatedTasks.js";
import { makeFakeClaudeBin, fakeSuccessEnvelope } from "../helpers/fakeClaude.js";
import { registerRobotSocket, unregisterRobotSocket } from "../../src/robotLink.js";
import { registerConsoleSocket, unregisterConsoleSocket } from "../../src/consoleLink.js";

const fakeClaudeBin = makeFakeClaudeBin();
// A handful of these tests call createDelegatedTask, which starts a real
// background worker — this MUST point at the fake binary, never the real
// `claude` CLI, or an "offline" adversarial run silently spends real
// subscription/API calls in the background (see TESTING-GATE.md's offline
// rule). Confirmed as a real bug here: before this was added, two tests
// below were quietly shelling out to the actual CLI.
process.env.CLAUDE_BIN = fakeClaudeBin;
process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();

before(() => {
  ensureDelegatedTasksDir();
});

after(() => {
  fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
});

test("ensureDelegatedTasksDir is idempotent and locks the directory down", () => {
  assert.doesNotThrow(() => ensureDelegatedTasksDir());
  assert.doesNotThrow(() => ensureDelegatedTasksDir());
  const mode = fs.statSync(DELEGATED_TASKS_DIR).mode & 0o777;
  assert.equal(mode, 0o700);
});

test("createDelegatedTask rejects empty/wrong-type title and request instead of writing a broken task file", () => {
  for (const bad of [undefined, null, "", "   ", 42, {}, [], true]) {
    assert.throws(() => createDelegatedTask({ title: bad, request: "do a thing" }), DelegateTaskError);
    assert.throws(() => createDelegatedTask({ title: "A title", request: bad }), DelegateTaskError);
  }
});

test("createDelegatedTask rejects oversized title/request", () => {
  assert.throws(() => createDelegatedTask({ title: "x".repeat(201), request: "fine" }), DelegateTaskError);
  assert.throws(() => createDelegatedTask({ title: "fine", request: "x".repeat(20_001) }), DelegateTaskError);
});

test("createDelegatedTask tolerates unicode, control characters and CRLF in title/request without throwing", () => {
  const { id } = createDelegatedTask({
    title: "Emoji \u{1F916} task\r\nwith newline",
    request: "Request with control char \x00 and CRLF\r\nhere, and unicode éè.",
  });
  const task = readTask(id);
  assert.equal(typeof task.title, "string");
  assert.equal(typeof task.request, "string");
});

test("readTask refuses path traversal / non-basename ids and never escapes the directory", () => {
  for (const id of ["../../../etc/passwd", "sub/dir", "a/b", "..", "."]) {
    assert.doesNotThrow(() => readTask(id));
    assert.equal(readTask(id), null);
  }
  assert.ok(!fs.existsSync(path.join(DELEGATED_TASKS_DIR, "..", "etc")));
});

test("readTask fails safe (null, no throw) for garbage id types, a missing id, and a corrupt file", () => {
  for (const id of [undefined, null, 123, {}, [], Symbol("x")]) {
    assert.doesNotThrow(() => readTask(id));
    assert.equal(readTask(id), null);
  }
  assert.equal(readTask("t-does-not-exist"), null);

  fs.writeFileSync(path.join(DELEGATED_TASKS_DIR, "t-corrupt.json"), "{not valid json");
  assert.equal(readTask("t-corrupt"), null);

  fs.writeFileSync(path.join(DELEGATED_TASKS_DIR, "t-wrong-shape.json"), JSON.stringify(["not", "an", "object"]));
  assert.equal(readTask("t-wrong-shape"), null);
});

test("listTasks skips corrupt task files instead of throwing", () => {
  fs.writeFileSync(path.join(DELEGATED_TASKS_DIR, "t-garbage-listing.json"), "{{{not json");
  assert.doesNotThrow(() => listTasks({ includeHeard: true }));
});

test("getTaskResult returns null for an unknown or garbage task_id, never throws", () => {
  for (const id of ["t-nope", "", null, undefined, 123, "../escape"]) {
    assert.doesNotThrow(() => getTaskResult(id));
    assert.equal(getTaskResult(id), null);
  }
});

test("getTaskResult never leaks the full `result` field, even for a task that already has one, and is idempotent across repeated calls", () => {
  const { id } = createDelegatedTask({ title: "Idempotent", request: "x" });
  fs.writeFileSync(
    path.join(DELEGATED_TASKS_DIR, `${id}.json`),
    JSON.stringify({
      id,
      title: "Idempotent",
      request: "x",
      status: "done",
      created: new Date().toISOString(),
      completed: new Date().toISOString(),
      summary: "Short summary.",
      result: "SENSITIVE FULL EMAIL BODY SHOULD NEVER LEAK",
      heard: false,
    }),
  );
  for (let i = 0; i < 3; i++) {
    const result = getTaskResult(id);
    assert.equal("result" in result, false);
    assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
  }
});

test("getTaskResult on a still-running task degrades gracefully (no summary yet) instead of throwing", () => {
  const { id } = createDelegatedTask({ title: "Still going", request: "x" });
  const result = getTaskResult(id);
  assert.equal(result.status, "running");
  assert.equal(result.summary, null);
  assert.equal(readTask(id).heard, true);
});

test("matchExplicitDelegate fails safe on null/undefined/non-string input", () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => matchExplicitDelegate(input));
    assert.equal(matchExplicitDelegate(input), null);
  }
});

test("matchExplicitDelegate does not match the phrase mid-sentence, or with nothing after it", () => {
  assert.equal(matchExplicitDelegate("could you delegate this for me"), null);
  assert.equal(matchExplicitDelegate("delegate this"), null);
  assert.equal(matchExplicitDelegate("delegate this.  "), null);
  assert.equal(matchExplicitDelegate("delegate this, , ,"), null);
});

test("matchExplicitDelegate handles a very long instruction without truncating or throwing", () => {
  const long = "x".repeat(50_000);
  const result = matchExplicitDelegate(`delegate this: ${long}`);
  assert.equal(result.instruction.length, long.length);
});

test("parseWorkerOutput fails safe for every malformed shape instead of throwing or crashing", () => {
  const cases = [
    { stdout: "", timedOut: false },
    { stdout: "not json at all", timedOut: false },
    { stdout: "null", timedOut: false },
    { stdout: "42", timedOut: false },
    { stdout: JSON.stringify({ is_error: true, result: "boom" }), timedOut: false },
    { stdout: JSON.stringify({ is_error: false }), timedOut: false },
    { stdout: JSON.stringify({ is_error: false, result: 12345 }), timedOut: false },
    { stdout: JSON.stringify({ is_error: false, result: "not json" }), timedOut: false },
    { stdout: JSON.stringify({ is_error: false, result: JSON.stringify({ result: "missing summary" }) }), timedOut: false },
    { stdout: JSON.stringify({ is_error: false, result: JSON.stringify({ summary: "", result: "x" }) }), timedOut: false },
    { stdout: JSON.stringify({ is_error: false, result: JSON.stringify({ summary: 5, result: "x" }) }), timedOut: false },
    { stdout: "whatever", timedOut: true },
    { stdout: "", timedOut: false, spawnError: "ENOENT" },
  ];
  for (const spawnResult of cases) {
    assert.doesNotThrow(() => parseWorkerOutput(spawnResult));
    const outcome = parseWorkerOutput(spawnResult);
    assert.equal(outcome.ok, false);
    assert.equal(typeof outcome.reason, "string");
    assert.ok(outcome.reason.length > 0);
  }
});

test("parseWorkerOutput's inner JSON parse is not vulnerable to prototype pollution via __proto__", () => {
  const innerJson = `{"__proto__": {"polluted": true}, "summary": "ok", "result": "r"}`;
  const spawnResult = { stdout: JSON.stringify({ is_error: false, result: innerJson }), timedOut: false };
  const outcome = parseWorkerOutput(spawnResult);
  assert.equal(outcome.ok, true);
  assert.equal({}.polluted, undefined);
});

test("scrubAnthropicEnv handles an empty object and a __proto__ key without throwing or polluting", () => {
  assert.deepEqual(scrubAnthropicEnv({}), {});
  const result = scrubAnthropicEnv({ __proto__: { polluted: true }, PATH: "/usr/bin" });
  assert.equal({}.polluted, undefined);
  assert.equal(result.PATH, "/usr/bin");
});

test("spawnClaudeWorker resolves (never throws/rejects) when the binary does not exist", async () => {
  const result = await spawnClaudeWorker({
    prompt: "x",
    claudeBin: "/no/such/binary/anywhere",
    env: process.env,
  });
  assert.equal(typeof result.spawnError, "string");
  assert.equal(result.timedOut, false);
});

test("spawnClaudeWorker kills a worker that runs past its timeout and reports timedOut", async () => {
  const result = await spawnClaudeWorker({
    prompt: "x",
    claudeBin: fakeClaudeBin,
    timeoutMs: 50,
    env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: "5000", FAKE_CLAUDE_RESPONSE: "{}" },
  });
  assert.equal(result.timedOut, true);
});

test("sweepRetention tolerates a corrupt file and an empty directory without throwing", () => {
  fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
  assert.doesNotThrow(() => sweepRetention());
  assert.equal(sweepRetention(), 0);

  ensureDelegatedTasksDir();
  fs.writeFileSync(path.join(DELEGATED_TASKS_DIR, "t-garbage-sweep.json"), "not json");
  assert.doesNotThrow(() => sweepRetention());
});

test("reconcileOrphanedTasks tolerates a corrupt task file without throwing", () => {
  ensureDelegatedTasksDir();
  fs.writeFileSync(path.join(DELEGATED_TASKS_DIR, "t-garbage-reconcile.json"), "not json");
  assert.doesNotThrow(() => reconcileOrphanedTasks());
});

async function waitUntilSettled(id, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = readTask(id);
    if (task && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${id} did not settle within ${timeoutMs}ms`);
}

test("worker output that can't even be turned into a failure reason fails the task instead of crashing the worker", async () => {
  // is_error with a result object whose toString isn't callable: String() on
  // it throws inside parseWorkerOutput, which runWorker's backstop catches.
  process.env.FAKE_CLAUDE_RESPONSE = JSON.stringify({ is_error: true, result: { toString: 1 } });
  try {
    const { id } = createDelegatedTask({ title: "Hostile output", request: "x" });
    const task = await waitUntilSettled(id);
    assert.equal(task.status, "failed");
    assert.equal(typeof task.summary, "string");
    assert.ok(task.summary.length > 0);
  } finally {
    process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  }
});

test("a bot connection that throws on send doesn't wedge the worker queue", async () => {
  // Armed only after registering: registerRobotSocket flushes frames queued
  // by earlier tests, and those must go through for setup to succeed.
  let armed = false;
  const throwingBot = {
    readyState: 1,
    isConsoleClient: false,
    send: () => {
      if (armed) throw new Error("socket exploded");
    },
  };
  registerRobotSocket(throwingBot);
  armed = true;
  let firstId;
  try {
    ({ id: firstId } = createDelegatedTask({ title: "Notify fails", request: "x" }));
    // The result is written before the bot is notified, so it still lands.
    assert.equal((await waitUntilSettled(firstId)).status, "done");
  } finally {
    unregisterRobotSocket(throwingBot);
  }
  // The pump's backstop released the worker slot: later tasks still run.
  const { id: laterId } = createDelegatedTask({ title: "After the throw", request: "x" });
  assert.equal((await waitUntilSettled(laterId)).status, "done");
});

test("a console connection that throws on send doesn't wedge the worker queue either", async () => {
  const throwingConsole = {
    readyState: 1,
    isConsoleClient: true,
    send: () => {
      throw new Error("console socket exploded");
    },
  };
  registerConsoleSocket(throwingConsole);
  try {
    const { id } = createDelegatedTask({ title: "Console notify fails", request: "x" });
    assert.equal((await waitUntilSettled(id)).status, "done");
  } finally {
    unregisterConsoleSocket(throwingConsole);
  }
  const { id: laterId } = createDelegatedTask({ title: "After the console throw", request: "x" });
  assert.equal((await waitUntilSettled(laterId)).status, "done");
});

// Relies on directory permissions, so it assumes a non-root run (the gate
// runs as the service user).
test("sweepRetention logs and skips a task file it can't delete, without throwing", async () => {
  ensureDelegatedTasksDir();
  const { id } = createDelegatedTask({ title: "Undeletable", request: "x" });
  await waitUntilSettled(id);
  getTaskResult(id);
  const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(DELEGATED_TASKS_DIR, `${id}.json`), JSON.stringify({ ...readTask(id), completed: TEN_DAYS_AGO }));

  // Read-only directory: the file can be listed and read but not unlinked.
  fs.chmodSync(DELEGATED_TASKS_DIR, 0o500);
  try {
    let removed;
    assert.doesNotThrow(() => {
      removed = sweepRetention(Date.now(), 7);
    });
    assert.equal(removed, 0);
    assert.equal(readTask(id).id, id);
  } finally {
    fs.chmodSync(DELEGATED_TASKS_DIR, 0o700);
  }
});
