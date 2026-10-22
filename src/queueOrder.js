import fs from "node:fs";
import path from "node:path";
import { listTaskFiles, sortOldestFirst } from "./taskFile.js";

// Manual priority for tasks/pending, set from the webapp's queue drawer.
// Stored as a JSON array of filenames in tasks/queue-order.json (gitignored
// runtime state, like logs/turns.db). It's an override layered on the
// oldest-first default, not a replacement: filenames listed in it run first,
// in that order; anything not listed (a task queued since the last reorder)
// falls in after them, oldest first. Stale entries for tasks that have left
// pending are ignored, so nothing needs cleaning up when a task is built.
export const ORDER_FILE = "queue-order.json";

export class QueueOrderError extends Error {}

function orderPath(root) {
  return path.join(root, "tasks", ORDER_FILE);
}

// Never throws: a missing or corrupt order file just means "no manual order".
export function readQueueOrder(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(orderPath(root), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export function applyQueueOrder(tasks, order) {
  const byName = new Map(tasks.map((t) => [t.filename, t]));
  const ranked = [];
  for (const name of order) {
    const task = byName.get(name);
    if (task) {
      ranked.push(task);
      byName.delete(name);
    }
  }
  return [...ranked, ...sortOldestFirst([...byName.values()])];
}

// Pending tasks in the order the build runner will take them.
export function listPendingInOrder(root) {
  const tasks = listTaskFiles(path.join(root, "tasks", "pending"));
  return applyQueueOrder(sortOldestFirst(tasks), readQueueOrder(root));
}

// Persists a new order. Must be exactly the current set of pending files
// (no unknowns, no duplicates, none missing) so a stale client — one that
// loaded the list before a task was queued or built — gets an error rather
// than silently dropping or resurrecting entries.
export function saveQueueOrder(root, order) {
  if (!Array.isArray(order) || !order.every((n) => typeof n === "string")) {
    throw new QueueOrderError("order must be an array of filenames");
  }
  const current = new Set(listPendingInOrder(root).map((t) => t.filename));
  if (new Set(order).size !== order.length) throw new QueueOrderError("order contains duplicates");
  if (order.length !== current.size || !order.every((n) => current.has(n))) {
    throw new QueueOrderError("order does not match the current pending queue — reload and try again");
  }
  const file = orderPath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(order, null, 2));
  fs.renameSync(tmp, file);
}
