import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { queueTask, rejectTask, RejectTaskError } from "../../src/taskQueue.js";
import { makeTmpDir, makeTmpRepo } from "../helpers/tmp.js";

const pendingFiles = (root) => {
  const dir = path.join(root, "tasks", "pending");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

// git needs an identity for the commit rejectTask makes.
function withGitIdentity(env, fn) {
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, Object.fromEntries(keys.map((k) => [k, env[k]])));
  const restore = () => keys.forEach((k) => (prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k])));
  try {
    return fn();
  } finally {
    restore();
  }
}

test("queueTask rejects missing, blank, wrong-type and oversized input without writing anything", () => {
  const root = makeTmpDir();
  const bad = [
    undefined,
    {},
    { title: "", description: "d" },
    { title: "   ", description: "d" },
    { title: "t", description: "" },
    { title: "t", description: "\n\t " },
    { title: 42, description: "d" },
    { title: "t", description: ["d"] },
    { title: null, description: null },
    { title: "t".repeat(201), description: "d" },
    { title: "t", description: "d".repeat(20_001) },
  ];
  for (const input of bad) assert.throws(() => queueTask(root, input ?? {}), Error);
  assert.deepEqual(pendingFiles(root), []);
});

test("queueTask keeps a hostile title out of the frontmatter and inside tasks/pending", async () => {
  const root = makeTmpDir(); // not a git repo: the commit fails, which must not throw
  const { filePath, committed } = queueTask(root, { title: "x\n---\nsource: evil\n../../etc/passwd", description: "d" });
  assert.equal(path.dirname(filePath), path.join(root, "tasks", "pending"));
  const raw = fs.readFileSync(filePath, "utf8");
  assert.equal(raw.match(/^source: /gm).length, 1);
  assert.match(raw, /^source: gatsby-conversation$/m);
  assert.equal(await committed, false);
});

test("two tasks queued in the same second never overwrite each other", async () => {
  const root = makeTmpDir();
  const a = queueTask(root, { title: "Same", description: "one" });
  const b = queueTask(root, { title: "Same", description: "two" });
  await Promise.all([a.committed, b.committed]);
  assert.notEqual(a.filePath, b.filePath);
  assert.equal(pendingFiles(root).length, 2);
});

test("writeSelfAuthoredTask never throws on a malformed proposal", async () => {
  const { writeSelfAuthoredTask } = await import("../../src/taskQueue.js");
  const root = makeTmpDir();
  const cwd = process.cwd();
  try {
    process.chdir(root);
    for (const bad of [undefined, null, {}, { title: "", description: "" }, { title: {}, description: [] }]) {
      assert.doesNotThrow(() => writeSelfAuthoredTask(bad));
    }
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(pendingFiles(root), []);
});

test("rejectTask rejects missing, blank and wrong-type filenames without touching the filesystem", () => {
  const root = makeTmpDir();
  for (const bad of [undefined, null, 42, {}, [], "", "   "]) {
    assert.throws(() => rejectTask(root, bad), RejectTaskError);
  }
  assert.equal(fs.existsSync(path.join(root, "tasks", "rejected")), false);
});

test("rejectTask rejects path-traversal filenames even when the traversal target exists", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "tasks", "pending"), { recursive: true });
  fs.writeFileSync(path.join(root, "tasks", "pending", "x.md"), "body\n");
  // a file genuinely sitting just outside tasks/pending, so a traversal that
  // "worked" would find something real to move.
  fs.writeFileSync(path.join(root, "tasks", "outside.md"), "secret\n");
  const traversalNames = ["../outside.md", "../../etc/passwd", "sub/x.md", "/etc/passwd", "tasks/pending/x.md"];
  for (const name of traversalNames) {
    assert.throws(() => rejectTask(root, name), RejectTaskError);
  }
  assert.equal(fs.existsSync(path.join(root, "tasks", "pending", "x.md")), true);
  assert.equal(fs.existsSync(path.join(root, "tasks", "outside.md")), true);
  assert.equal(fs.existsSync(path.join(root, "tasks", "rejected")), false);
});

test("rejectTask rejects an unknown filename without creating tasks/rejected", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "tasks", "pending"), { recursive: true });
  assert.throws(() => rejectTask(root, "nope.md"), RejectTaskError);
  assert.equal(fs.existsSync(path.join(root, "tasks", "rejected")), false);
});

test("rejectTask fails safely when called again on an already-rejected file", () => {
  const { dir, env } = makeTmpRepo();
  fs.mkdirSync(path.join(dir, "tasks", "pending"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tasks", "pending", "x.md"), "body\n");
  withGitIdentity(env, () => rejectTask(dir, "x.md"));
  assert.throws(() => rejectTask(dir, "x.md"), RejectTaskError);
  assert.equal(fs.readFileSync(path.join(dir, "tasks", "rejected", "x.md"), "utf8"), "body\n");
});

test("rejectTask refuses to overwrite a pre-existing tasks/rejected entry", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "tasks", "pending"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks", "rejected"), { recursive: true });
  fs.writeFileSync(path.join(root, "tasks", "pending", "x.md"), "new body\n");
  fs.writeFileSync(path.join(root, "tasks", "rejected", "x.md"), "old rejected body\n");
  assert.throws(() => rejectTask(root, "x.md"), RejectTaskError);
  assert.equal(fs.readFileSync(path.join(root, "tasks", "pending", "x.md"), "utf8"), "new body\n");
  assert.equal(fs.readFileSync(path.join(root, "tasks", "rejected", "x.md"), "utf8"), "old rejected body\n");
});

test("rejectTask on a non-git directory throws rather than silently losing the moved file", () => {
  const root = makeTmpDir(); // not a git repo: git add/commit fail, and that failure must not be swallowed
  fs.mkdirSync(path.join(root, "tasks", "pending"), { recursive: true });
  fs.writeFileSync(path.join(root, "tasks", "pending", "x.md"), "body\n");
  assert.throws(() => rejectTask(root, "x.md"));
  // the file move itself still happened; only the git commit failed.
  assert.equal(fs.existsSync(path.join(root, "tasks", "pending", "x.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "tasks", "rejected", "x.md"), "utf8"), "body\n");
});
