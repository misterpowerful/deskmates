import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskNotification, describeTaskNotification } from "../../webapp/src/composables/taskNotifications.js";

test("parseTaskNotification accepts a well-formed task_notification frame", () => {
  const parsed = parseTaskNotification({ type: "task_notification", task_id: "t-1", title: "Emails", status: "done" });
  assert.deepEqual(parsed, { task_id: "t-1", title: "Emails", status: "done" });
});

test("describeTaskNotification produces plain, readable text for each known status", () => {
  assert.equal(describeTaskNotification({ title: "Emails", status: "done" }), '"Emails" finished.');
  assert.equal(describeTaskNotification({ title: "Emails", status: "failed" }), '"Emails" failed.');
  assert.equal(
    describeTaskNotification({ title: "Draft reply", status: "needs_confirmation" }),
    '"Draft reply" needs your sign-off.',
  );
});

test("describeTaskNotification falls back to a generic sentence when the title is blank", () => {
  assert.equal(describeTaskNotification({ title: "", status: "done" }), "A background task finished.");
});
