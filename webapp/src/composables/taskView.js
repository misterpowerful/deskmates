// Framework-free helpers for the Tasks view (components/TasksPanel.vue):
// grouping, labels, ages, the read-aloud prompt, and image sizing math. No
// Vue/Quasar imports so it's testable under plain node:test — same split as
// taskNotifications.js and menuViews.js.

const STATUS_LABELS = {
  running: "In progress",
  done: "Done",
  failed: "Failed",
  needs_confirmation: "Needs your sign-off",
};

// Anything that isn't an object with a string id is dropped rather than
// rendered — a malformed row off the wire must never break the whole list.
function wellFormed(tasks) {
  return Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === "object" && typeof t.id === "string" && t.id) : [];
}

const isRead = (t) => Boolean(t.viewedAt) || Boolean(t.heard);

// Buckets for the Tasks view, each newest-first (input order is preserved,
// and the API already returns newest first):
//   needsSignOff — worker prepared something that waits on the person
//   inFlight     — still running
//   ready        — finished, and neither read on screen nor heard aloud yet
//   failed       — failed and not yet looked at
//   earlier      — everything already read/heard (done, failed or signed off)
// An unknown status counts as earlier so a future status can't vanish.
export function groupTasks(tasks) {
  const groups = { needsSignOff: [], inFlight: [], ready: [], failed: [], earlier: [] };
  for (const t of wellFormed(tasks)) {
    if (t.status === "running") groups.inFlight.push(t);
    else if (t.status === "needs_confirmation" && !t.viewedAt) groups.needsSignOff.push(t);
    else if (t.status === "done" && !isRead(t)) groups.ready.push(t);
    else if (t.status === "failed" && !t.viewedAt) groups.failed.push(t);
    else groups.earlier.push(t);
  }
  return groups;
}

// How many tasks want a human's attention — drives an optional badge.
export function attentionCount(tasks) {
  const g = groupTasks(tasks);
  return g.needsSignOff.length + g.ready.length + g.failed.length;
}

export function needsPolling(tasks) {
  return wellFormed(tasks).some((t) => t.status === "running");
}

export function statusLabel(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : String(status ?? "unknown");
}

// "just now" / "5m ago" / "2h ago" / "3d ago"; "" for a missing or
// unparseable timestamp (and for one in the future, which clock skew between
// the server and phone can produce — better blank than "-4m ago").
export function formatAge(iso, now = Date.now()) {
  const then = Date.parse(iso ?? "");
  if (!Number.isFinite(then)) return "";
  const sec = Math.floor((now - then) / 1000);
  if (sec < 0) return "";
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// The sentence the "Read to me" button sends as a text request. It rides the
// existing list_tasks/get_task_result flow (the model resolves the task and
// the bot speaks the summary, marking it heard) instead of a new protocol.
// The title is flattened and capped since it ends up inside a model prompt.
export function readAloudPrompt(task) {
  const title = String(task?.title ?? "").replace(/[\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const id = String(task?.id ?? "");
  return title ? `Read me the result of the task called "${title}" (task id ${id}).` : `Read me the result of task ${id}.`;
}

// <img src> can't send a header, so the token rides the query string — same
// pattern as apiFetch. Returns "" for a bad id so the UI shows no image
// rather than a request to a malformed path.
export function taskImageUrl(id, token) {
  if (typeof id !== "string" || !/^t-[a-z0-9-]+$/.test(id)) return "";
  return `/api/tasks/${id}/image?${new URLSearchParams({ token: String(token ?? "") })}`;
}

// Scale (w, h) down so the longer edge is at most maxEdge, never up, always
// whole pixels >= 1. Non-finite or non-positive input yields null — the
// caller then uploads the original untouched instead of a 0x0 canvas.
export function fitWithin(width, height, maxEdge = 1568) {
  if (![width, height, maxEdge].every(Number.isFinite) || width <= 0 || height <= 0 || maxEdge <= 0) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
