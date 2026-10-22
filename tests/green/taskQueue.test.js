import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { queueTask, rejectTask, GATSBY_CONVERSATION_SOURCE } from "../../src/taskQueue.js";
import { makeTmpRepo } from "../helpers/tmp.js";

// git needs an identity for the commit queueTask makes.
function withGitIdentity(env, fn) {
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, Object.fromEntries(keys.map((k) => [k, env[k]])));
  const restore = () => keys.forEach((k) => (prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k])));
  return fn().finally(restore);
}

test("queueTask writes a gatsby-conversation task file into tasks/pending and commits only that file", async () => {
  const { dir, git, env } = makeTmpRepo();
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "leave me uncommitted\n");
  await withGitIdentity(env, async () => {
    const { filePath, filename, committed } = queueTask(dir, { title: "Drawer UI", description: "Drag to reorder." });
    assert.equal(path.dirname(filePath), path.join(dir, "tasks", "pending"));
    assert.match(filename, /^drawer-ui-\d+\.md$/);
    const raw = fs.readFileSync(filePath, "utf8");
    assert.match(raw, new RegExp(`source: ${GATSBY_CONVERSATION_SOURCE}`));
    assert.match(raw, /title: Drawer UI/);
    assert.match(raw, /Drag to reorder\./);
    assert.equal(await committed, true);
  });
  assert.match(git("log", "-1", "--format=%s"), /Add self-authored task \(conversation\): Drawer UI/);
  assert.match(git("status", "--porcelain"), /\?\? unrelated\.txt/);
});

test("writeSelfAuthoredTask writes a proposed idea into the cwd's tasks/pending", async () => {
  const { writeSelfAuthoredTask } = await import("../../src/taskQueue.js");
  const { dir, env } = makeTmpRepo();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await withGitIdentity(env, async () => {
      writeSelfAuthoredTask({ title: "An idea", description: "Do the thing." });
      // the file is written synchronously; give the background commit time to settle
      await new Promise((r) => setTimeout(r, 500));
    });
  } finally {
    process.chdir(cwd);
  }
  assert.equal(fs.readdirSync(path.join(dir, "tasks", "pending")).length, 1);
});

function seedTask(dir, subdir, filename, body = "---\ntitle: A task\n---\nDo the thing.\n") {
  const taskDir = path.join(dir, "tasks", subdir);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, filename), body);
}

test("rejectTask moves a pending task into tasks/rejected and commits the move", async () => {
  const { dir, git, env } = makeTmpRepo();
  seedTask(dir, "pending", "x.md");
  await withGitIdentity(env, async () => {
    const result = rejectTask(dir, "x.md");
    assert.deepEqual(result, { filename: "x.md", fromDir: "pending" });
  });
  assert.equal(fs.existsSync(path.join(dir, "tasks", "pending", "x.md")), false);
  assert.equal(fs.existsSync(path.join(dir, "tasks", "rejected", "x.md")), true);
  assert.match(git("log", "-1", "--format=%s"), /^Reject task: x\.md$/);
  assert.equal(git("status", "--porcelain"), "");
});

test("rejectTask prefers tasks/proposed over tasks/pending when a task is in both", async () => {
  const { dir, env } = makeTmpRepo();
  seedTask(dir, "proposed", "x.md", "proposed body\n");
  seedTask(dir, "pending", "x.md", "pending body\n");
  await withGitIdentity(env, async () => {
    const result = rejectTask(dir, "x.md");
    assert.equal(result.fromDir, "proposed");
  });
  assert.equal(fs.readFileSync(path.join(dir, "tasks", "rejected", "x.md"), "utf8"), "proposed body\n");
  assert.equal(fs.existsSync(path.join(dir, "tasks", "pending", "x.md")), true);
});

test("rejectTask appends a reason note to the moved file and records it in the commit message", async () => {
  const { dir, git, env } = makeTmpRepo();
  seedTask(dir, "pending", "x.md", "---\ntitle: A task\n---\nDo the thing.\n");
  await withGitIdentity(env, async () => {
    rejectTask(dir, "x.md", "not worth building");
  });
  const raw = fs.readFileSync(path.join(dir, "tasks", "rejected", "x.md"), "utf8");
  assert.match(raw, /Rejected: not worth building/);
  assert.match(git("log", "-1", "--format=%s"), /^Reject task: x\.md — not worth building$/);
});
