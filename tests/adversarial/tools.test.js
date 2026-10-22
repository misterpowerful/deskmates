import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getCustomTools, runCustomTool } from "../../src/tools/index.js";
import { DELEGATED_TASKS_DIR } from "../../src/delegatedTasks.js";

const names = (tools) => tools.map((t) => t.name);

test("never offers propose and confirm together, for any pending value", () => {
  for (const pending of [undefined, null, 0, "", false, {}, { x: 1 }, "yes", 1]) {
    const n = names(getCustomTools({ pendingGithubWrite: pending }));
    assert.equal(n.includes("github_propose_write") && n.includes("github_confirm_write"), false);
    assert.equal(n.includes("github_propose_write") || n.includes("github_confirm_write"), true);
  }
});

test("memoryTriggered must be truthy exactly; default options are safe", () => {
  assert.ok(!names(getCustomTools({}, {})).includes("save_memory"));
  assert.ok(!names(getCustomTools({}, { memoryTriggered: false })).includes("save_memory"));
  assert.ok(!names(getCustomTools({}, undefined)).includes("save_memory"));
});

test("confirm without a pending proposal is refused as an error result, not an exception", async () => {
  const ws = {};
  const res = await runCustomTool(ws, "github_confirm_write", {}, "x");
  assert.equal(res.isError, true);
  assert.match(res.text, /No pending GitHub write/);
});

test("github_list_commits with missing/hostile input errors cleanly without touching the network", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  };
  try {
    for (const input of [null, undefined, {}, { owner: "o" }, { repo: "r" }, { owner: 1, repo: 2 }, { owner: "", repo: "" }]) {
      const res = await runCustomTool({}, "github_list_commits", input, "x");
      assert.equal(res.isError, true);
      assert.match(res.text, /owner and repo are required/);
    }
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("unknown tools and null input are errors, not crashes", async () => {
  assert.equal((await runCustomTool({}, "does_not_exist", null, "x")).isError, true);
  assert.equal((await runCustomTool({}, "__proto__", undefined, "x")).isError, true);
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    const res = await runCustomTool({}, name, { a: 1 }, "x");
    assert.equal(res.isError, true, name);
    assert.match(res.text, /Unknown tool/);
  }
});

test("save_memory rejects empty or non-string facts before touching disk", async () => {
  for (const fact of ["", "   ", null, 42, {}]) {
    const res = await runCustomTool({}, "save_memory", { fact }, "nobody");
    assert.equal(res.isError, true);
  }
});

test("a propose call consumes nothing but records exactly one pending write", async () => {
  const ws = {};
  const res = await runCustomTool(ws, "github_propose_write", { owner: "o", repo: "r", path: "p", content: "c", message: "m" }, "x");
  assert.equal(res.isError, false);
  assert.equal(ws.pendingGithubWrite.owner, "o");
});

test("queue_task is never offered for missing, unknown or hostile personality names", () => {
  for (const p of [undefined, null, "", "__proto__", "constructor", 42, ["gatsby-sardonic"], "x".repeat(100_000)]) {
    assert.ok(!names(getCustomTools({ lastKnownPersonality: p })).includes("queue_task"));
  }
  assert.ok(!names(getCustomTools({})).includes("queue_task"));
});

test("queue_task refuses a personality that is not approved, and writes nothing", async () => {
  const before = fs.readdirSync("tasks/pending").length;
  const out = await runCustomTool({}, "queue_task", { title: "t", description: "d" }, "no-such-personality");
  assert.equal(out.isError, true);
  assert.match(out.text, /not available to this personality/);
  for (const bad of [undefined, "", "__proto__", "constructor"]) {
    assert.equal((await runCustomTool({}, "queue_task", { title: "t", description: "d" }, bad)).isError, true);
  }
  assert.equal(fs.readdirSync("tasks/pending").length, before);
});

test("queue_task with hostile input from an approved personality errors cleanly and writes nothing", async () => {
  const before = fs.readdirSync("tasks/pending").length;
  for (const input of [undefined, null, {}, { title: "t" }, { title: 1, description: 2 }, { title: "", description: "d" }]) {
    const out = await runCustomTool({}, "queue_task", input, "gatsby-sardonic");
    assert.equal(out.isError, true);
  }
  assert.equal(fs.readdirSync("tasks/pending").length, before);
});

test("robot_find_me is withheld on the agent-SDK bridge while ws.robotAnnouncing is set, even though the robot is connected", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  const fakeBot = { readyState: 1, isConsoleClient: false, send: () => {} };
  registerRobotSocket(fakeBot);
  try {
    for (const announcing of [true, 1, "yes", {}, ["x"]]) {
      const server = createDeskmatesMcpServer({ robotAnnouncing: announcing }, "gatsby-sardonic", {});
      assert.ok(
        !Object.keys(server.instance._registeredTools).includes("robot_find_me"),
        `expected robot_find_me withheld for robotAnnouncing=${JSON.stringify(announcing)}`,
      );
    }
  } finally {
    unregisterRobotSocket(fakeBot);
  }
});

test("robot_find_me disappears from the bridge the instant the robot disconnects", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  const fakeBot = { readyState: 1, isConsoleClient: false, send: () => {} };
  registerRobotSocket(fakeBot);
  const withBot = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
  assert.ok(Object.keys(withBot.instance._registeredTools).includes("robot_find_me"));
  unregisterRobotSocket(fakeBot);
  const withoutBot = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
  assert.ok(!Object.keys(withoutBot.instance._registeredTools).includes("robot_find_me"));
});

test("a stale/closed robot socket (readyState !== OPEN) does not make robot_find_me available on the bridge", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  for (const readyState of [0, 2, 3, undefined]) {
    const fakeBot = { readyState, isConsoleClient: false, send: () => {} };
    registerRobotSocket(fakeBot);
    try {
      const server = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
      assert.ok(!Object.keys(server.instance._registeredTools).includes("robot_find_me"), `readyState=${readyState}`);
    } finally {
      unregisterRobotSocket(fakeBot);
    }
  }
});

test("a console client socket never counts as the robot for the bridge's gating", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  const consoleClient = { readyState: 1, isConsoleClient: true, send: () => {} };
  registerRobotSocket(consoleClient);
  try {
    const server = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
    assert.ok(!Object.keys(server.instance._registeredTools).includes("robot_find_me"));
  } finally {
    unregisterRobotSocket(consoleClient);
  }
});

test("delegate_task/list_tasks/get_task_result are absent from the bridge for any non-friendly effectiveMode, including undefined", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  for (const mode of ["sentry_intruder", "bump_complaint", "deep_thoughtful", undefined, "", null]) {
    const server = createDeskmatesMcpServer({}, "gatsby-sardonic", { effectiveMode: mode });
    const names = Object.keys(server.instance._registeredTools);
    assert.ok(!names.includes("delegate_task"), `effectiveMode=${JSON.stringify(mode)}`);
    assert.ok(!names.includes("list_tasks"), `effectiveMode=${JSON.stringify(mode)}`);
    assert.ok(!names.includes("get_task_result"), `effectiveMode=${JSON.stringify(mode)}`);
  }
});

test("the bridge actually threads effectiveMode through to runCustomTool's dispatch, not just the tool list — delegate_task's handler succeeds in friendly mode", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const server = createDeskmatesMcpServer({}, "x", { effectiveMode: "friendly" });
  const handler = server.instance._registeredTools.delegate_task.handler;
  const result = await handler({ title: "Bridge regression check", request: "r" }, {});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /task_id/);
  fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
});

test("robot_find_me's bridge handler fails safely (not an exception) when no robot is actually connected at call time", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  const fakeBot = { readyState: 1, isConsoleClient: false, send: () => {} };
  registerRobotSocket(fakeBot);
  const server = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
  const handler = server.instance._registeredTools.robot_find_me.handler;
  unregisterRobotSocket(fakeBot);
  const result = await handler({}, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not connected/);
});

test("delegate_task/list_tasks/get_task_result are never offered outside friendly mode, for any mode value", () => {
  for (const mode of ["deep_thoughtful", "sentry_intruder", "bump_complaint", "friendly ", "FRIENDLY", "", null, undefined, 42, {}]) {
    const n = names(getCustomTools({}, { effectiveMode: mode }));
    assert.ok(!n.includes("delegate_task"));
    assert.ok(!n.includes("list_tasks"));
    assert.ok(!n.includes("get_task_result"));
  }
});

test("delegate_task/list_tasks/get_task_result refuse to actually run outside friendly mode even if called directly (defense in depth)", async () => {
  for (const mode of ["deep_thoughtful", "sentry_intruder", "bump_complaint", undefined, null, "", "Friendly"]) {
    const res = await runCustomTool({}, "delegate_task", { title: "t", request: "r" }, "x", mode);
    assert.equal(res.isError, true);
    assert.match(res.text, /not available/);

    const listRes = await runCustomTool({}, "list_tasks", {}, "x", mode);
    assert.equal(listRes.isError, true);

    const getRes = await runCustomTool({}, "get_task_result", { task_id: "t-whatever" }, "x", mode);
    assert.equal(getRes.isError, true);
  }
  fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
});

test("delegate_task with hostile/malformed input fails as an error result, not an exception, and writes nothing", async () => {
  fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
  for (const input of [null, undefined, {}, { title: "" }, { request: "r" }, { title: 1, request: 2 }, { title: "x".repeat(300), request: "r" }]) {
    const res = await runCustomTool({}, "delegate_task", input, "x", "friendly");
    assert.equal(res.isError, true);
  }
  assert.equal(fs.existsSync(DELEGATED_TASKS_DIR) ? fs.readdirSync(DELEGATED_TASKS_DIR).length : 0, 0);
});

test("runCustomTool falls back sanely on calendar_create_event when ws.timezone is missing or invalid, instead of erroring", async () => {
  const realFetch = globalThis.fetch;
  process.env.GOOGLE_CLIENT_ID = "a";
  process.env.GOOGLE_CLIENT_SECRET = "b";
  process.env.GOOGLE_REFRESH_TOKEN = "c";
  let lastBody;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    lastBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ id: "evt1", htmlLink: "https://calendar.google.com/evt1" }), { status: 200 });
  };
  try {
    for (const ws of [{}, { timezone: null }, { timezone: "" }, { timezone: "Not/AZone" }, { timezone: 42 }]) {
      const res = await runCustomTool(
        ws,
        "calendar_create_event",
        { summary: "S", start: "2026-10-14T14:00:00", end: "2026-10-14T15:00:00" },
        "x",
      );
      assert.equal(res.isError, false, JSON.stringify(ws));
      // Falls back through the repo's real config.json default_timezone rather than throwing or leaving timeZone unset.
      assert.ok(lastBody.start.timeZone, `expected a fallback timeZone for ws=${JSON.stringify(ws)}`);
      assert.equal(lastBody.start.timeZone, lastBody.end.timeZone);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("get_task_result with a garbage task_id (path traversal, wrong type) fails cleanly", async () => {
  for (const task_id of ["../../etc/passwd", "sub/dir", 42, {}, null, undefined, ""]) {
    const res = await runCustomTool({}, "get_task_result", { task_id }, "x", "friendly");
    assert.equal(res.isError, true);
    assert.match(res.text, /No such task/);
  }
});
