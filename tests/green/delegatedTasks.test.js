import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import {
  DELEGATED_TASKS_DIR,
  ensureDelegatedTasksDir,
  createDelegatedTask,
  readTask,
  listTasks,
  countUnheardTasks,
  getTaskResult,
  matchExplicitDelegate,
  parseWorkerOutput,
  spawnClaudeWorker,
  scrubAnthropicEnv,
  sweepRetention,
  reconcileOrphanedTasks,
} from "../../src/delegatedTasks.js";
import { registerRobotSocket, unregisterRobotSocket } from "../../src/robotLink.js";
import { registerConsoleSocket, unregisterConsoleSocket } from "../../src/consoleLink.js";
import { makeFakeClaudeBin, fakeSuccessEnvelope } from "../helpers/fakeClaude.js";

const fakeClaudeBin = makeFakeClaudeBin();

before(() => {
  ensureDelegatedTasksDir();
  process.env.CLAUDE_BIN = fakeClaudeBin;
});

after(() => {
  fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
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

test("scrubAnthropicEnv removes exactly the two Anthropic billing vars and keeps everything else", () => {
  const scrubbed = scrubAnthropicEnv({
    ANTHROPIC_API_KEY: "sk-x",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
    PATH: "/usr/bin",
  });
  assert.equal("ANTHROPIC_API_KEY" in scrubbed, false);
  assert.equal("ANTHROPIC_AUTH_TOKEN" in scrubbed, false);
  assert.equal(scrubbed.CLAUDE_CODE_OAUTH_TOKEN, "keep-me");
  assert.equal(scrubbed.PATH, "/usr/bin");
});

test("matchExplicitDelegate matches both phrases and extracts the instruction", () => {
  assert.deepEqual(matchExplicitDelegate("delegate this: summarize my unread emails"), {
    phrase: "delegate this",
    instruction: "summarize my unread emails",
  });
  assert.deepEqual(matchExplicitDelegate("Hand this off, add lunch to my calendar"), {
    phrase: "hand this off",
    instruction: "add lunch to my calendar",
  });
});

test("matchExplicitDelegate tolerates a leading quote and is case-insensitive", () => {
  const result = matchExplicitDelegate('"DELEGATE THAT - research the new coffee shop');
  assert.equal(result.phrase, "delegate that");
  assert.equal(result.instruction, "research the new coffee shop");
});

test("createDelegatedTask writes a running task immediately, readable by id", () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const { id } = createDelegatedTask({ title: "Email summary", request: "Summarize unread email" });
  const task = readTask(id);
  assert.equal(task.title, "Email summary");
  assert.equal(task.request, "Summarize unread email");
  assert.equal(task.status, "running");
  assert.equal(task.heard, false);
  assert.equal(task.completed, null);
});

test("a worker that reports success completes the task as done with a summary and result", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope({ summary: "All caught up.", result: "3 unread, none urgent." });
  const { id } = createDelegatedTask({ title: "Emails", request: "Summarize unread email" });
  const task = await waitUntilSettled(id);
  assert.equal(task.status, "done");
  assert.equal(task.summary, "All caught up.");
  assert.equal(task.result, "3 unread, none urgent.");
  assert.equal(typeof task.completed, "string");
});

test("a worker that sets needs_confirmation lands the task in needs_confirmation", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope({ needsConfirmation: true, summary: "Draft ready." });
  const { id } = createDelegatedTask({ title: "Draft reply", request: "Draft a reply to Jane" });
  const task = await waitUntilSettled(id);
  assert.equal(task.status, "needs_confirmation");
});

test("the physical bot is notified with a task_done frame once a task settles", async () => {
  const sent = [];
  const fakeBot = { readyState: 1, isConsoleClient: false, send: (msg) => sent.push(JSON.parse(msg)) };
  registerRobotSocket(fakeBot);
  try {
    process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
    const { id } = createDelegatedTask({ title: "Notify me", request: "Do a thing" });
    await waitUntilSettled(id);
    const frame = sent.find((f) => f.task_id === id);
    assert.ok(frame, "expected a task_done frame for this task id");
    assert.equal(frame.type, "task_done");
    assert.equal(frame.status, "done");
  } finally {
    unregisterRobotSocket(fakeBot);
  }
});

test("every open console (webapp/debug console) socket gets a task_notification frame once a task settles, independent of the bot's task_done frame", async () => {
  const consoleSent = [];
  const fakeConsole = { readyState: 1, isConsoleClient: true, send: (msg) => consoleSent.push(JSON.parse(msg)) };
  registerConsoleSocket(fakeConsole);
  try {
    process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
    const { id } = createDelegatedTask({ title: "Notify console", request: "Do a thing" });
    await waitUntilSettled(id);
    const frame = consoleSent.find((f) => f.task_id === id);
    assert.ok(frame, "expected a task_notification frame for this task id");
    assert.equal(frame.type, "task_notification");
    assert.equal(frame.title, "Notify console");
    assert.equal(frame.status, "done");
  } finally {
    unregisterConsoleSocket(fakeConsole);
  }
});

test("listTasks defaults to unheard only; include_heard reveals everything", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const { id } = createDelegatedTask({ title: "List me", request: "Do a thing" });
  await waitUntilSettled(id);
  const before_ = listTasks();
  assert.ok(before_.some((t) => t.id === id));

  getTaskResult(id);
  const unheardAfter = listTasks();
  assert.equal(unheardAfter.some((t) => t.id === id), false);
  const allAfter = listTasks({ includeHeard: true });
  assert.ok(allAfter.some((t) => t.id === id));
});

test("getTaskResult returns title/status/summary only, and marks the task heard", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope({ summary: "Spoken-length summary." });
  const { id } = createDelegatedTask({ title: "Result shape", request: "Do a thing" });
  await waitUntilSettled(id);
  const result = getTaskResult(id);
  assert.deepEqual(Object.keys(result).sort(), ["status", "summary", "title"]);
  assert.equal(result.summary, "Spoken-length summary.");
  assert.equal(readTask(id).heard, true);
});

test("countUnheardTasks reflects list_tasks' default filter", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const before_ = countUnheardTasks();
  const { id } = createDelegatedTask({ title: "Count me", request: "Do a thing" });
  await waitUntilSettled(id);
  assert.equal(countUnheardTasks(), before_ + 1);
  getTaskResult(id);
  assert.equal(countUnheardTasks(), before_);
});

test("parseWorkerOutput happily unwraps both JSON layers", () => {
  const spawnResult = { stdout: fakeSuccessEnvelope({ summary: "s", result: "r", needsConfirmation: true }), timedOut: false, exitCode: 0 };
  const outcome = parseWorkerOutput(spawnResult);
  assert.deepEqual(outcome, { ok: true, summary: "s", result: "r", needsConfirmation: true });
});

test("spawnClaudeWorker resolves with the fake binary's stdout", async () => {
  const stdout = fakeSuccessEnvelope({ summary: "direct call" });
  const result = await spawnClaudeWorker({
    prompt: "irrelevant for the fake binary",
    claudeBin: fakeClaudeBin,
    env: { ...process.env, FAKE_CLAUDE_RESPONSE: stdout },
  });
  assert.equal(result.stdout, stdout);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
});

test("sweepRetention removes an old heard task but leaves a recent one and an unheard one alone", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const { id: oldHeardId } = createDelegatedTask({ title: "Old heard", request: "x" });
  const { id: recentHeardId } = createDelegatedTask({ title: "Recent heard", request: "x" });
  const { id: unheardId } = createDelegatedTask({ title: "Still unheard", request: "x" });
  await waitUntilSettled(oldHeardId);
  await waitUntilSettled(recentHeardId);
  await waitUntilSettled(unheardId);
  getTaskResult(oldHeardId);
  getTaskResult(recentHeardId);

  // Backdate oldHeardId's completed timestamp directly — the real elapsed
  // time between these three creations is milliseconds, nowhere near the
  // retention window, so "old" has to be forced rather than waited for.
  const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const oldTask = readTask(oldHeardId);
  fs.writeFileSync(`${DELEGATED_TASKS_DIR}/${oldHeardId}.json`, JSON.stringify({ ...oldTask, completed: TEN_DAYS_AGO }));

  const removed = sweepRetention(Date.now(), 7);
  assert.ok(removed >= 1);
  assert.equal(readTask(oldHeardId), null);
  assert.equal(readTask(recentHeardId).id, recentHeardId);
  assert.equal(readTask(unheardId).id, unheardId);
});

test("reconcileOrphanedTasks marks a still-running task as failed", () => {
  // Written directly (bypassing createDelegatedTask) so no real worker ever
  // starts for this id — the scenario under test is a task left "running"
  // because the *previous* process died, not a race against this one.
  const id = "t-orphan-test";
  fs.writeFileSync(
    `${DELEGATED_TASKS_DIR}/${id}.json`,
    JSON.stringify({
      id,
      title: "Orphan",
      request: "x",
      status: "running",
      created: new Date().toISOString(),
      completed: null,
      summary: null,
      result: null,
      heard: false,
    }),
  );
  reconcileOrphanedTasks();
  const task = readTask(id);
  assert.equal(task.status, "failed");
  assert.match(task.summary, /restart/i);
});

// A stand-in child process for spawnClaudeWorker's spawnFn seam: records the
// argv it was spawned with, then emits the given stdout/stderr and closes.
function fakeChild({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", exitCode);
    });
    return child;
  };
  return { spawnFn, calls };
}

test("WORKER_ALLOWED_TOOLS overrides the default tool list, trimmed and with blanks dropped", async () => {
  const { spawnFn, calls } = fakeChild({ stdout: fakeSuccessEnvelope() });
  const previous = process.env.WORKER_ALLOWED_TOOLS;
  process.env.WORKER_ALLOWED_TOOLS = " WebSearch , ,mcp__claude_ai_Google_Calendar__list_events ";
  try {
    await spawnClaudeWorker({ prompt: "p", spawnFn });
  } finally {
    if (previous === undefined) delete process.env.WORKER_ALLOWED_TOOLS;
    else process.env.WORKER_ALLOWED_TOOLS = previous;
  }
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--allowedTools") + 1], "WebSearch,mcp__claude_ai_Google_Calendar__list_events");
});

test("spawnClaudeWorker captures the worker's stderr alongside its stdout", async () => {
  const { spawnFn } = fakeChild({ stdout: "out", stderr: "warning: something", exitCode: 1 });
  const result = await spawnClaudeWorker({ prompt: "p", spawnFn });
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "warning: something");
  assert.equal(result.exitCode, 1);
});
