import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { makeTmpDir } from "../helpers/tmp.js";
import { makeFakeClaudeBin, fakeSuccessEnvelope } from "../helpers/fakeClaude.js";
import { JPEG } from "../helpers/visionFixtures.js";

// Own cwd before import (delegatedTasks.js fixes its directory at import).
const sandbox = makeTmpDir("deskmates-taskapi-green-");
process.chdir(sandbox);
process.env.CLAUDE_BIN = makeFakeClaudeBin();
process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope({ summary: "A mug.", result: "A white mug on a desk." });

const { DELEGATED_TASKS_DIR, ensureDelegatedTasksDir, readTask } = await import("../../src/delegatedTasks.js");
const { handleTasksApi, sendTasksApiResult, readRawBody, MAX_TASK_UPLOAD_BYTES } = await import("../../src/taskApi.js");

before(() => ensureDelegatedTasksDir());
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const call = (method, pathname, { query = "", body = Buffer.alloc(0) } = {}) =>
  handleTasksApi({ method, pathname, query: new URLSearchParams(query), readBody: async () => body });

async function settled(id) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const t = readTask(id);
    if (t && t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("did not settle");
}

function fakeRes() {
  const res = { status: null, headers: null, body: null };
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
  };
  return res;
}

test("POST /api/tasks/vision creates a task; it then lists, details, serves its image, and can be marked viewed", async () => {
  const created = await call("POST", "/api/tasks/vision", { query: "title=Desk&note=what%20is%20this", body: JPEG });
  assert.equal(created.status, 201);
  const { id } = created.json;
  await settled(id);

  const list = await call("GET", "/api/tasks");
  assert.equal(list.status, 200);
  const row = list.json.tasks.find((t) => t.id === id);
  assert.equal(row.title, "Desk");
  assert.equal(row.status, "done");
  assert.equal(row.hasImage, true);

  const detail = await call("GET", `/api/tasks/${id}`);
  assert.equal(detail.json.result, "A white mug on a desk.");

  const image = await call("GET", `/api/tasks/${id}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.file.mimeType, "image/jpeg");
  assert.deepEqual(fs.readFileSync(image.file.path), JPEG);

  const viewed = await call("POST", `/api/tasks/${id}/viewed`);
  assert.equal(viewed.status, 200);
  assert.ok(viewed.json.viewedAt);
});

test("paths outside /api/tasks are not handled (null) so server.js can fall through", async () => {
  assert.equal(await call("GET", "/api/turns"), null);
  assert.equal(await call("GET", "/api/tasksfoo"), null);
});

test("sendTasksApiResult writes JSON with no-store and an image with its type", async () => {
  const jsonRes = fakeRes();
  await sendTasksApiResult(jsonRes, { status: 201, json: { id: "t-1" } });
  assert.equal(jsonRes.status, 201);
  assert.equal(jsonRes.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(jsonRes.body), { id: "t-1" });

  const file = path.join(DELEGATED_TASKS_DIR, "t-sendtest.jpg");
  fs.writeFileSync(file, JPEG);
  const imgRes = fakeRes();
  await sendTasksApiResult(imgRes, { status: 200, file: { path: file, mimeType: "image/jpeg" } });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers["Content-Type"], "image/jpeg");
  assert.equal(imgRes.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual(imgRes.body, JPEG);
});

test("readRawBody concatenates chunks", async () => {
  const body = await readRawBody(Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
  assert.equal(body.toString(), "abcd");
  assert.ok(MAX_TASK_UPLOAD_BYTES > 5 * 1024 * 1024);
});
