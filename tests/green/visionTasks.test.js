import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../helpers/tmp.js";
import { makeFakeClaudeBin, fakeSuccessEnvelope } from "../helpers/fakeClaude.js";
import { JPEG, PNG, WEBP } from "../helpers/visionFixtures.js";

// delegatedTasks.js fixes its directory from process.cwd() at import time, so
// this file gets its own cwd *before* importing it. node --test runs each file
// in its own process, so this never touches the real delegated-tasks/ or any
// other test file's.
const sandbox = makeTmpDir("deskmates-vision-green-");
process.chdir(sandbox);
const record = path.join(sandbox, "claude-invocation.json");
process.env.CLAUDE_BIN = makeFakeClaudeBin();
process.env.FAKE_CLAUDE_RECORD = record;

const mod = await import("../../src/delegatedTasks.js");
const {
  DELEGATED_TASKS_DIR,
  ensureDelegatedTasksDir,
  createVisionTask,
  sniffImageType,
  taskImageInfo,
  listTaskDetails,
  getTaskDetail,
  markTaskViewed,
  listTasks,
  readTask,
  sweepRetention,
} = mod;

before(() => ensureDelegatedTasksDir());
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

async function settled(id, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = readTask(id);
    if (t && t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${id} did not settle`);
}

test("sniffImageType recognises jpeg, png and webp by magic bytes", () => {
  assert.equal(sniffImageType(JPEG), "jpg");
  assert.equal(sniffImageType(PNG), "png");
  assert.equal(sniffImageType(WEBP), "webp");
});

test("a vision task stores its image next to the task file and runs to done", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope({ summary: "A mug on a desk.", result: "A white ceramic mug." });
  const { id } = createVisionTask({ title: "Desk photo", note: "what is on my desk?", image: JPEG });

  const created = readTask(id);
  assert.equal(created.kind, "vision");
  assert.equal(created.title, "Desk photo");
  assert.equal(created.request, "what is on my desk?");
  assert.equal(created.image, `${id}.jpg`);
  assert.equal(created.viewedAt, null);
  assert.deepEqual(fs.readFileSync(path.join(DELEGATED_TASKS_DIR, created.image)), JPEG);

  const done = await settled(id);
  assert.equal(done.status, "done");
  assert.equal(done.summary, "A mug on a desk.");
  assert.equal(done.result, "A white ceramic mug.");
});

test("a vision worker gets the Read tool only, runs in the tasks directory, and is pointed at the image by bare filename", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  // Even an operator-level override of the normal worker tools must not leak
  // into photo tasks (they get Read only — see the module comment).
  process.env.WORKER_ALLOWED_TOOLS = "WebSearch,mcp__claude_ai__Gmail__create_draft";
  try {
    const { id } = createVisionTask({ title: "Args", note: "", image: PNG });
    await settled(id);
  } finally {
    delete process.env.WORKER_ALLOWED_TOOLS;
  }
  const rec = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.equal(rec.argv[rec.argv.indexOf("--allowedTools") + 1], "Read");
  assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(DELEGATED_TASKS_DIR));
  const prompt = rec.argv[rec.argv.indexOf("-p") + 1];
  const imageName = rec.files.find((f) => f.endsWith(".png"));
  assert.ok(imageName, "the image must be inside the worker's cwd");
  assert.ok(prompt.includes(`./${imageName}`));
});

test("title defaults to Photo and note is capped", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const { id } = createVisionTask({ image: WEBP, note: "x".repeat(900) });
  const task = readTask(id);
  assert.equal(task.title, "Photo");
  assert.equal(task.request.length, 500);
  assert.equal(task.image, `${id}.webp`);
  await settled(id);
});

test("listTaskDetails/getTaskDetail expose the UI view; request stays internal, result only on detail", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope({ summary: "Sum.", result: "Full result." });
  const { id } = createVisionTask({ title: "Detail", note: "secret instruction", image: JPEG });
  await settled(id);

  const row = listTaskDetails().find((t) => t.id === id);
  assert.equal(row.kind, "vision");
  assert.equal(row.status, "done");
  assert.equal(row.hasImage, true);
  assert.equal(row.summary, "Sum.");
  assert.equal(row.heard, false);
  assert.equal(row.viewedAt, null);
  assert.equal("result" in row, false);
  assert.equal("request" in row, false);

  const detail = getTaskDetail(id);
  assert.equal(detail.result, "Full result.");
  assert.equal("request" in detail, false);
});

test("markTaskViewed stamps viewedAt once, leaves heard alone, and keeps the task on the bot's unheard list", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const { id } = createVisionTask({ title: "View me", image: JPEG });
  await settled(id);

  const first = markTaskViewed(id);
  assert.ok(first.viewedAt);
  assert.equal(first.heard, false);
  assert.equal(markTaskViewed(id).viewedAt, first.viewedAt, "a second view must not move the timestamp");
  assert.ok(listTasks().some((t) => t.id === id), "bot's list_tasks still reports it until it's actually heard");
});

test("taskImageInfo returns the file path and mime type", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const { id } = createVisionTask({ title: "Img", image: PNG });
  await settled(id);
  const info = taskImageInfo(id);
  assert.equal(info.mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(info.path), PNG);
});

test("sweepRetention removes an old viewed vision task together with its image, and keeps an unread one", async () => {
  process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();
  const viewed = createVisionTask({ title: "Old viewed", image: JPEG }).id;
  const unread = createVisionTask({ title: "Old unread", image: JPEG }).id;
  await settled(viewed);
  await settled(unread);
  markTaskViewed(viewed);

  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  for (const id of [viewed, unread]) {
    const file = path.join(DELEGATED_TASKS_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...readTask(id), completed: longAgo }));
  }

  sweepRetention(Date.now(), 7);
  assert.equal(readTask(viewed), null);
  assert.equal(fs.existsSync(path.join(DELEGATED_TASKS_DIR, `${viewed}.jpg`)), false);
  assert.ok(readTask(unread));
  assert.equal(fs.existsSync(path.join(DELEGATED_TASKS_DIR, `${unread}.jpg`)), true);
});
