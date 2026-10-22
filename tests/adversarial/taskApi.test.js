import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { makeTmpDir } from "../helpers/tmp.js";
import { makeFakeClaudeBin, fakeSuccessEnvelope } from "../helpers/fakeClaude.js";
import { JPEG } from "../helpers/visionFixtures.js";

const sandbox = makeTmpDir("deskmates-taskapi-adv-");
process.chdir(sandbox);
process.env.CLAUDE_BIN = makeFakeClaudeBin();
process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();

const { DELEGATED_TASKS_DIR, ensureDelegatedTasksDir, readTask } = await import("../../src/delegatedTasks.js");
const { handleTasksApi, sendTasksApiResult, readRawBody, TaskApiError } = await import("../../src/taskApi.js");

before(() => ensureDelegatedTasksDir());
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const call = (method, pathname, { query = "", readBody = async () => Buffer.alloc(0) } = {}) =>
  handleTasksApi({ method, pathname, query: new URLSearchParams(query), readBody });

test("unsupported methods and routes get 404/405, never a crash", async () => {
  assert.equal((await call("DELETE", "/api/tasks")).status, 405);
  assert.equal((await call("PUT", "/api/tasks")).status, 405);
  assert.equal((await call("GET", "/api/tasks/vision")).status, 405);
  assert.equal((await call("POST", "/api/tasks/vision/extra")).status, 404);
  assert.equal((await call("POST", "/api/tasks/t-abc")).status, 405);
  assert.equal((await call("GET", "/api/tasks/t-abc/bogus")).status, 404);
  assert.equal((await call("DELETE", "/api/tasks/t-abc/viewed")).status, 404);
});

test("malformed, traversal-style and unknown ids are 404", async () => {
  for (const id of ["..", "%2e%2e", "t-", "T-ABC", "t-abc/../../x", "t_abc", "__proto__", "t-abc.json", "t-abc%00", " "]) {
    for (const [method, suffix] of [["GET", ""], ["GET", "/image"], ["POST", "/viewed"]]) {
      const r = await call(method, `/api/tasks/${id}${suffix}`);
      assert.ok(r.status === 404, `${method} /api/tasks/${id}${suffix} -> ${r.status}`);
    }
  }
  assert.equal((await call("GET", "/api/tasks/t-doesnotexist-1")).status, 404);
  assert.equal((await call("GET", "/api/tasks/t-doesnotexist-1/image")).status, 404);
  assert.equal((await call("POST", "/api/tasks/t-doesnotexist-1/viewed")).status, 404);
});

test("uploading something that isn't an image is a 400 with a plain message and creates nothing", async () => {
  const before_ = fs.readdirSync(DELEGATED_TASKS_DIR).length;
  for (const body of [Buffer.alloc(0), Buffer.from("<script>alert(1)</script>"), Buffer.from("GIF89a"), Buffer.alloc(100, 0x41)]) {
    const r = await call("POST", "/api/tasks/vision", { readBody: async () => body });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /JPEG, PNG or WebP/);
  }
  assert.equal(fs.readdirSync(DELEGATED_TASKS_DIR).length, before_);
});

test("an oversized body is a 413 from the reader, and the API surfaces it", async () => {
  const stream = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
  stream.destroy = () => {};
  await assert.rejects(readRawBody(stream, 1000), (err) => err instanceof TaskApiError && err.status === 413);

  const r = await call("POST", "/api/tasks/vision", {
    readBody: async () => {
      throw new TaskApiError(413, "body too large");
    },
  });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, "body too large");
});

test("an unexpected error is a generic 500 that does not leak the internal message", async () => {
  const r = await call("POST", "/api/tasks/vision", {
    readBody: async () => {
      throw new Error("ENOENT /var/secret/path");
    },
  });
  assert.equal(r.status, 500);
  assert.equal(JSON.stringify(r.json).includes("secret"), false);
});

test("title/note query values are data: a hostile note never changes the stored title or widens anything", async () => {
  const r = await call("POST", "/api/tasks/vision", {
    query: new URLSearchParams({ title: "<img src=x onerror=alert(1)>", note: "'; DROP TABLE tasks;--" }).toString(),
    readBody: async () => JPEG,
  });
  assert.equal(r.status, 201);
  const task = readTask(r.json.id);
  assert.equal(task.title, "<img src=x onerror=alert(1)>", "stored verbatim as text; the UI renders it escaped via Vue's {{ }}");
  assert.equal(task.kind, "vision");
});

test("sendTasksApiResult turns a vanished image into a clean 404", async () => {
  const res = { writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
  await sendTasksApiResult(res, { status: 200, file: { path: path.join(sandbox, "gone.jpg"), mimeType: "image/jpeg" } });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "not found" });
});
