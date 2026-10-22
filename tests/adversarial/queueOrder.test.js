import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readQueueOrder, listPendingInOrder, saveQueueOrder, applyQueueOrder, QueueOrderError, ORDER_FILE } from "../../src/queueOrder.js";
import { makeTmpDir } from "../helpers/tmp.js";

function seedRoot(names) {
  const root = makeTmpDir();
  const pending = path.join(root, "tasks", "pending");
  fs.mkdirSync(pending, { recursive: true });
  names.forEach((name, i) => {
    fs.writeFileSync(path.join(pending, name), `---\ncreated: 2026-01-0${i + 1}T00:00:00Z\n---\nbody\n`);
  });
  return root;
}
const orderFile = (root) => path.join(root, "tasks", ORDER_FILE);

test("saveQueueOrder rejects non-array and non-string input without touching state", () => {
  const root = seedRoot(["a.md"]);
  for (const bad of [undefined, null, "a.md", {}, 42, [1], [null], [{}], [["a.md"]]]) {
    assert.throws(() => saveQueueOrder(root, bad), QueueOrderError);
  }
  assert.equal(fs.existsSync(orderFile(root)), false);
});

test("saveQueueOrder rejects unknown, missing, duplicate and out-of-range entries", () => {
  const root = seedRoot(["a.md", "b.md"]);
  for (const bad of [[], ["a.md"], ["a.md", "b.md", "c.md"], ["a.md", "a.md"], ["a.md", "nope.md"], ["b.md", "b.md", "a.md"]]) {
    assert.throws(() => saveQueueOrder(root, bad), QueueOrderError);
  }
  assert.equal(fs.existsSync(orderFile(root)), false);
});

test("path traversal, control-char and prototype-pollution names are rejected, not written", () => {
  const root = seedRoot(["a.md"]);
  const evil = ["../../etc/passwd", "../pending/a.md", "a.md" + String.fromCharCode(0), "__proto__", "constructor", "a.md\r\n", "/abs/a.md"];
  for (const name of evil) {
    assert.throws(() => saveQueueOrder(root, [name]), QueueOrderError);
  }
  assert.equal(fs.existsSync(orderFile(root)), false);
  assert.equal({}.polluted, undefined);
});

test("a failed save leaves the previous order intact", () => {
  const root = seedRoot(["a.md", "b.md"]);
  saveQueueOrder(root, ["b.md", "a.md"]);
  assert.throws(() => saveQueueOrder(root, ["a.md"]), QueueOrderError);
  assert.deepEqual(readQueueOrder(root), ["b.md", "a.md"]);
});

test("a corrupt or wrong-shaped order file degrades to oldest-first instead of crashing", () => {
  const root = seedRoot(["a.md", "b.md"]);
  const junk = ["{not json", "", "null", '{"a":1}', String.fromCharCode(0, 1), "x".repeat(200000)];
  for (const content of junk) {
    fs.writeFileSync(orderFile(root), content);
    assert.deepEqual(readQueueOrder(root), []);
    assert.deepEqual(listPendingInOrder(root).map((t) => t.filename), ["a.md", "b.md"]);
  }
});

test("non-string entries inside a stored order are dropped", () => {
  const root = seedRoot(["a.md", "b.md"]);
  fs.writeFileSync(orderFile(root), JSON.stringify([null, 7, { x: 1 }, "b.md", ["a.md"]]));
  assert.deepEqual(readQueueOrder(root), ["b.md"]);
  assert.deepEqual(listPendingInOrder(root).map((t) => t.filename), ["b.md", "a.md"]);
});

test("a missing tasks/pending directory yields an empty queue and an empty order is accepted", () => {
  const root = makeTmpDir();
  assert.deepEqual(listPendingInOrder(root), []);
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  saveQueueOrder(root, []);
  assert.deepEqual(readQueueOrder(root), []);
});

test("applyQueueOrder tolerates duplicates and unknown names in the stored order", () => {
  const tasks = ["x", "y"].map((filename) => ({ filename, frontmatter: {}, mtimeMs: 0 }));
  assert.deepEqual(applyQueueOrder(tasks, ["y", "y", "ghost", "__proto__", "x"]).map((t) => t.filename), ["y", "x"]);
});

test("repeated saves are idempotent and unicode filenames round-trip", () => {
  const root = seedRoot(["a.md", "é-任务.md"]);
  saveQueueOrder(root, ["é-任务.md", "a.md"]);
  saveQueueOrder(root, ["é-任务.md", "a.md"]);
  assert.deepEqual(listPendingInOrder(root).map((t) => t.filename), ["é-任务.md", "a.md"]);
});
