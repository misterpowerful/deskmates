import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getCustomTools, runCustomTool } from "../../src/tools/index.js";
import { DELEGATED_TASKS_DIR } from "../../src/delegatedTasks.js";
import { makeFakeClaudeBin, fakeSuccessEnvelope } from "../helpers/fakeClaude.js";

process.env.CLAUDE_BIN = makeFakeClaudeBin();
process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
after(() => fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true }));

const names = (tools) => tools.map((t) => t.name);

test("with no pending proposal, propose is offered and confirm is not", () => {
  const n = names(getCustomTools({}));
  assert.ok(n.includes("github_propose_write"));
  assert.ok(!n.includes("github_confirm_write"));
});

test("with a pending proposal, confirm is offered and propose is not", () => {
  const n = names(getCustomTools({ pendingGithubWrite: { owner: "o" } }));
  assert.ok(n.includes("github_confirm_write"));
  assert.ok(!n.includes("github_propose_write"));
});

test("github_list_commits is always offered alongside github_read_file and github_list_repos", () => {
  const n = names(getCustomTools({}));
  assert.ok(n.includes("github_list_commits"));
  assert.ok(n.includes("github_read_file"));
  assert.ok(n.includes("github_list_repos"));
});

test("save_memory appears only when memoryTriggered", () => {
  assert.ok(!names(getCustomTools({})).includes("save_memory"));
  assert.ok(names(getCustomTools({}, { memoryTriggered: true })).includes("save_memory"));
});

test("queue_task is offered only to a personality approved for self-improvement", () => {
  assert.ok(!names(getCustomTools({})).includes("queue_task"));
  assert.ok(!names(getCustomTools({ lastKnownPersonality: "no-such-personality" })).includes("queue_task"));
  // gatsby-sardonic is the entry in the repo's config.json self_improve_personalities.
  assert.ok(names(getCustomTools({ lastKnownPersonality: "gatsby-sardonic" })).includes("queue_task"));
});

test("createDeskmatesMcpServer builds for approved and unapproved personalities", async () => {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  for (const personality of ["gatsby-sardonic", "no-such-personality"]) {
    const server = createDeskmatesMcpServer({}, personality, { memoryTriggered: true });
    assert.equal(server.name, "deskmates-tools");
  }
});

test("delegate_task/list_tasks/get_task_result are offered through the agent-SDK bridge only in friendly mode, matching the API path", async () => {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const friendly = createDeskmatesMcpServer({}, "gatsby-sardonic", { effectiveMode: "friendly" });
  const friendlyNames = Object.keys(friendly.instance._registeredTools);
  assert.ok(friendlyNames.includes("delegate_task"));
  assert.ok(friendlyNames.includes("list_tasks"));
  assert.ok(friendlyNames.includes("get_task_result"));
  for (const mode of ["sentry_intruder", "bump_complaint", "deep_thoughtful", undefined]) {
    const server = createDeskmatesMcpServer({}, "gatsby-sardonic", { effectiveMode: mode });
    const modeNames = Object.keys(server.instance._registeredTools);
    assert.ok(!modeNames.includes("delegate_task"));
    assert.ok(!modeNames.includes("list_tasks"));
    assert.ok(!modeNames.includes("get_task_result"));
  }
});

test("robot_find_me is offered through the agent-SDK bridge while the robot is connected, matching the API path", async () => {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  const fakeBot = { readyState: 1, isConsoleClient: false, send: () => {} };
  registerRobotSocket(fakeBot);
  try {
    const server = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
    const names = Object.keys(server.instance._registeredTools);
    assert.ok(names.includes("robot_find_me"));
  } finally {
    unregisterRobotSocket(fakeBot);
  }
});

test("robot_find_me, once offered through the bridge, dispatches through runCustomTool and sends the same robot_command frame", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const { registerRobotSocket, unregisterRobotSocket } = await import("../../src/robotLink.js");
  const sent = [];
  const fakeBot = { readyState: 1, isConsoleClient: false, send: (msg) => sent.push(JSON.parse(msg)) };
  registerRobotSocket(fakeBot);
  try {
    const server = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
    const result = await server.instance._registeredTools.robot_find_me.handler({}, {});
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Search started/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "robot_command");
    assert.equal(sent[0].action, "summon");
  } finally {
    unregisterRobotSocket(fakeBot);
  }
});

test("robot_find_me is absent from the bridge when the robot is not connected", async () => {
  const { createDeskmatesMcpServer } = await import("../../src/tools/agentSdkBridge.js");
  const server = createDeskmatesMcpServer({}, "gatsby-sardonic", {});
  assert.ok(!Object.keys(server.instance._registeredTools).includes("robot_find_me"));
});

test("runCustomTool dispatches github_list_commits through the GitHub API and returns JSON text", async () => {
  const realFetch = globalThis.fetch;
  process.env.GITHUB_PAT = "x";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/commits?")) {
      return new Response(
        JSON.stringify([{ sha: "a1", commit: { message: "m", author: { name: "A", date: "d" } } }]),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ sha: "a1", commit: { message: "m", author: { name: "A", date: "d" } }, files: [] }),
      { status: 200 },
    );
  };
  try {
    const res = await runCustomTool({}, "github_list_commits", { owner: "o", repo: "r" }, "x");
    assert.equal(res.isError, false);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.commits[0].sha, "a1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runCustomTool queue_task writes and commits a task for an approved personality", async () => {
  const { runCustomTool: run } = await import("../../src/tools/index.js");
  const { makeTmpRepo } = await import("../helpers/tmp.js");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const { dir, git, env } = makeTmpRepo();
  const cwd = process.cwd();
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL });
  try {
    process.chdir(dir);
    // Approval comes from the repo's real config.json (read when config.js loaded).
    const out = await run({}, "queue_task", { title: "Reorder drawer", description: "Drag and drop." }, "gatsby-sardonic");
    assert.equal(out.isError, false);
    assert.match(out.text, /Queued as reorder-drawer-\d+\.md in tasks\/pending\//);
    assert.doesNotMatch(out.text, /commit failed/);
    assert.equal(fsMod.readdirSync(pathMod.join(dir, "tasks", "pending")).length, 1);
    assert.match(git("log", "-1", "--format=%s"), /Reorder drawer/);
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("runCustomTool attaches ws.timezone to calendar_create_event and calendar_list_events, through the shared dispatch", async () => {
  const realFetch = globalThis.fetch;
  process.env.GOOGLE_CLIENT_ID = "a";
  process.env.GOOGLE_CLIENT_SECRET = "b";
  process.env.GOOGLE_REFRESH_TOKEN = "c";
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    if ((opts?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ id: "evt1", htmlLink: "https://calendar.google.com/evt1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  try {
    const ws = { timezone: "America/Chicago" };
    const createRes = await runCustomTool(
      ws,
      "calendar_create_event",
      { summary: "Dentist", start: "2026-10-14T14:00:00", end: "2026-10-14T15:00:00" },
      "x",
    );
    assert.equal(createRes.isError, false);
    const createBody = JSON.parse(calls.at(-1).opts.body);
    assert.equal(createBody.start.timeZone, "America/Chicago");
    assert.equal(createBody.end.timeZone, "America/Chicago");

    const listRes = await runCustomTool(ws, "calendar_list_events", { time_min: "a", time_max: "b" }, "x");
    assert.equal(listRes.isError, false);
    const listUrl = new URL(calls.at(-1).url);
    assert.equal(listUrl.searchParams.get("timeZone"), "America/Chicago");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("delegate_task/list_tasks/get_task_result are offered only in friendly mode", () => {
  const n = names(getCustomTools({}, { effectiveMode: "friendly" }));
  assert.ok(n.includes("delegate_task"));
  assert.ok(n.includes("list_tasks"));
  assert.ok(n.includes("get_task_result"));
  for (const mode of ["deep_thoughtful", "sentry_intruder", "bump_complaint", undefined]) {
    const modeNames = names(getCustomTools({}, { effectiveMode: mode }));
    assert.ok(!modeNames.includes("delegate_task"));
    assert.ok(!modeNames.includes("list_tasks"));
    assert.ok(!modeNames.includes("get_task_result"));
  }
});

test("delegate_task creates a task and returns a task_id immediately, through runCustomTool", async () => {
  const res = await runCustomTool({}, "delegate_task", { title: "Emails", request: "Summarize unread email" }, "x", "friendly");
  assert.equal(res.isError, false);
  const { task_id } = JSON.parse(res.text);
  assert.match(task_id, /^t-/);
});

test("list_tasks and get_task_result round-trip through runCustomTool in friendly mode", async () => {
  const created = await runCustomTool({}, "delegate_task", { title: "Round trip", request: "Do a thing" }, "x", "friendly");
  const { task_id } = JSON.parse(created.text);

  const listed = await runCustomTool({}, "list_tasks", {}, "x", "friendly");
  assert.equal(listed.isError, false);
  assert.ok(JSON.parse(listed.text).some((t) => t.id === task_id));

  const result = await runCustomTool({}, "get_task_result", { task_id }, "x", "friendly");
  assert.equal(result.isError, false);
  assert.deepEqual(Object.keys(JSON.parse(result.text)).sort(), ["status", "summary", "title"]);
});
