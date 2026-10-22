import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskNotification, describeTaskNotification } from "../../webapp/src/composables/taskNotifications.js";

test("parseTaskNotification fails safe (null, no throw) for malformed/hostile frames", () => {
  const cases = [
    null,
    undefined,
    42,
    "task_notification",
    [],
    {},
    { task_id: "", status: "done" },
    { task_id: "t-1", status: "" },
    { task_id: 123, status: "done" },
    { task_id: "t-1", status: 456 },
    { task_id: "t-1", status: null },
    { task_id: null, status: "done" },
    { task_id: "t-1" },
    { status: "done" },
  ];
  for (const msg of cases) {
    assert.doesNotThrow(() => parseTaskNotification(msg));
    assert.equal(parseTaskNotification(msg), null);
  }
});

test("parseTaskNotification tolerates a missing/non-string title by defaulting to an empty string, not throwing", () => {
  for (const title of [undefined, null, 42, {}, []]) {
    const parsed = parseTaskNotification({ task_id: "t-1", status: "done", title });
    assert.equal(parsed.title, "");
  }
});

test("parseTaskNotification ignores extra/unexpected fields (prototype pollution attempt) without throwing or polluting", () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "task_id": "t-1", "status": "done"}');
  assert.doesNotThrow(() => parseTaskNotification(hostile));
  const parsed = parseTaskNotification(hostile);
  assert.deepEqual(parsed, { task_id: "t-1", title: "", status: "done" });
  assert.equal({}.polluted, undefined);
});

test("describeTaskNotification fails safe for an unknown status value instead of throwing", () => {
  assert.doesNotThrow(() => describeTaskNotification({ title: "x", status: "something_unexpected" }));
  assert.equal(describeTaskNotification({ title: "x", status: "something_unexpected" }), '"x" something_unexpected.');
});

test("describeTaskNotification handles a very long title without throwing or truncating", () => {
  const long = "x".repeat(10_000);
  const text = describeTaskNotification({ title: long, status: "done" });
  assert.ok(text.includes(long));
});
