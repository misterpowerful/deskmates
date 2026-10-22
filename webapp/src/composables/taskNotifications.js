// Parses/describes task_notification frames — src/consoleLink.js's
// broadcast of a delegated task's completion (src/delegatedTasks.js's
// notifyTaskDone) to every open webapp/console connection. Kept
// framework-free (no Vue/Quasar import) so it's testable under plain
// node:test; the actual toast ($q.notify) fires from App.vue, which has the
// Quasar context this module doesn't.

const STATUS_TEXT = {
  done: "finished",
  failed: "failed",
  needs_confirmation: "needs your sign-off",
};

// Fails safe (null) for anything that isn't a well-formed task_notification
// frame — a malformed or hostile frame off the wire must never throw inside
// session.js's dispatch.
export function parseTaskNotification(msg) {
  if (!msg || typeof msg !== "object") return null;
  const { task_id, status } = msg;
  if (typeof task_id !== "string" || !task_id) return null;
  if (typeof status !== "string" || !status) return null;
  const title = typeof msg.title === "string" ? msg.title : "";
  return { task_id, title, status };
}

// Plain one-line toast text, never spoken — matches the existing rule
// (CAPABILITIES.md's "Async task delegation") that a finished background
// task never interrupts an unrelated conversation.
export function describeTaskNotification({ title, status }) {
  const what = STATUS_TEXT[status] ?? status;
  return title ? `"${title}" ${what}.` : `A background task ${what}.`;
}
