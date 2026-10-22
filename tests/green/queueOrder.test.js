import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyQueueOrder, readQueueOrder, listPendingInOrder, saveQueueOrder, ORDER_FILE } from "../../src/queueOrder.js";
import { makeTmpDir } from "../helpers/tmp.js";

function seedRoot(names) {
  const root = makeTmpDir();
  const pending = path.join(root, "tasks", "pending");
  fs.mkdirSync(pending, { recursive: true });
  names.forEach((name, i) => {
    const created = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    fs.writeFileSync(path.join(pending, name), `---\ncreated: ${created}\ntitle: ${name}\n---\nbody\n`);
  });
  return root;
}
const names = (tasks) => tasks.map((t) => t.filename);

test("with no order file the queue is oldest-first", () => {
  const root = seedRoot(["a.md", "b.md", "c.md"]);
  assert.deepEqual(names(listPendingInOrder(root)), ["a.md", "b.md", "c.md"]);
});

test("saveQueueOrder makes the saved order the build order", () => {
  const root = seedRoot(["a.md", "b.md", "c.md"]);
  saveQueueOrder(root, ["c.md", "a.md", "b.md"]);
  assert.deepEqual(readQueueOrder(root), ["c.md", "a.md", "b.md"]);
  assert.deepEqual(names(listPendingInOrder(root)), ["c.md", "a.md", "b.md"]);
  assert.equal(fs.readdirSync(path.join(root, "tasks")).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("tasks queued after a reorder land after the ordered ones, oldest first", () => {
  const root = seedRoot(["a.md", "b.md"]);
  saveQueueOrder(root, ["b.md", "a.md"]);
  const pending = path.join(root, "tasks", "pending");
  fs.writeFileSync(path.join(pending, "z.md"), "---\ncreated: 2026-06-01T00:00:00Z\n---\nx\n");
  fs.writeFileSync(path.join(pending, "y.md"), "---\ncreated: 2026-05-01T00:00:00Z\n---\nx\n");
  assert.deepEqual(names(listPendingInOrder(root)), ["b.md", "a.md", "y.md", "z.md"]);
});

test("entries for tasks no longer pending are ignored", () => {
  const root = seedRoot(["a.md", "b.md"]);
  saveQueueOrder(root, ["b.md", "a.md"]);
  fs.unlinkSync(path.join(root, "tasks", "pending", "b.md"));
  assert.deepEqual(names(listPendingInOrder(root)), ["a.md"]);
});

test("applyQueueOrder puts listed names first in the given order", () => {
  const tasks = ["x", "y", "z"].map((filename) => ({ filename, frontmatter: {}, mtimeMs: 0 }));
  assert.deepEqual(names(applyQueueOrder(tasks, ["z", "x"])), ["z", "x", "y"]);
});

test("the order file lives outside tasks/pending so it is never listed as a task", () => {
  const root = seedRoot(["a.md"]);
  saveQueueOrder(root, ["a.md"]);
  assert.ok(fs.existsSync(path.join(root, "tasks", ORDER_FILE)));
  assert.deepEqual(names(listPendingInOrder(root)), ["a.md"]);
});
