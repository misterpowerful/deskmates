import test from "node:test";
import assert from "node:assert/strict";
import {
  groupTasks,
  attentionCount,
  needsPolling,
  statusLabel,
  formatAge,
  readAloudPrompt,
  taskImageUrl,
  fitWithin,
} from "../../webapp/src/composables/taskView.js";

const t = (id, status, extra = {}) => ({ id, title: id, status, heard: false, viewedAt: null, ...extra });

test("groupTasks buckets by status and read state, preserving order", () => {
  const g = groupTasks([
    t("t-a", "running"),
    t("t-b", "done"),
    t("t-c", "done", { viewedAt: "2026-10-21T00:00:00Z" }),
    t("t-d", "done", { heard: true }),
    t("t-e", "failed"),
    t("t-f", "failed", { viewedAt: "2026-10-21T00:00:00Z" }),
    t("t-g", "needs_confirmation"),
    t("t-h", "needs_confirmation", { viewedAt: "2026-10-21T00:00:00Z" }),
    t("t-i", "done"),
  ]);
  assert.deepEqual(g.inFlight.map((x) => x.id), ["t-a"]);
  assert.deepEqual(g.ready.map((x) => x.id), ["t-b", "t-i"]);
  assert.deepEqual(g.failed.map((x) => x.id), ["t-e"]);
  assert.deepEqual(g.needsSignOff.map((x) => x.id), ["t-g"]);
  assert.deepEqual(g.earlier.map((x) => x.id), ["t-c", "t-d", "t-f", "t-h"]);
});

test("attentionCount counts sign-off, ready and failed; needsPolling is true only while something runs", () => {
  const tasks = [t("t-a", "running"), t("t-b", "done"), t("t-c", "failed"), t("t-d", "needs_confirmation"), t("t-e", "done", { heard: true })];
  assert.equal(attentionCount(tasks), 3);
  assert.equal(needsPolling(tasks), true);
  assert.equal(needsPolling(tasks.slice(1)), false);
});

test("statusLabel names the known statuses and passes unknown ones through", () => {
  assert.equal(statusLabel("running"), "In progress");
  assert.equal(statusLabel("needs_confirmation"), "Needs your sign-off");
  assert.equal(statusLabel("weird"), "weird");
});

test("formatAge gives compact relative times", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(formatAge("2026-10-21T11:59:40Z", now), "just now");
  assert.equal(formatAge("2026-10-21T11:55:00Z", now), "5m ago");
  assert.equal(formatAge("2026-10-21T09:00:00Z", now), "3h ago");
  assert.equal(formatAge("2026-10-18T12:00:00Z", now), "3d ago");
});

test("readAloudPrompt names the task by title and id", () => {
  assert.equal(
    readAloudPrompt({ id: "t-abc-1", title: "Desk photo" }),
    'Read me the result of the task called "Desk photo" (task id t-abc-1).',
  );
  assert.equal(readAloudPrompt({ id: "t-abc-1", title: "" }), "Read me the result of task t-abc-1.");
});

test("taskImageUrl builds the tokened image path", () => {
  assert.equal(taskImageUrl("t-abc-1", "tok"), "/api/tasks/t-abc-1/image?token=tok");
});

test("fitWithin scales the long edge down to the cap and never up", () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1568, height: 1176 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1176, height: 1568 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
});
