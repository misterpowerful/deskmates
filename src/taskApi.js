// REST surface for the webapp's Tasks view: the delegated-task queue (src/
// delegatedTasks.js) as JSON, plus photo upload and the photo itself. Lives in
// src/ rather than server.js so it's testable offline (server.js only calls
// handleTasksApi and sendTasksApiResult). Auth is NOT handled here — server.js
// already gates everything under /api/ with the bot token before routing.
//
//   GET  /api/tasks                      -> { tasks: [...] } newest first, all statuses
//   GET  /api/tasks/:id                  -> one task incl. full `result`
//   GET  /api/tasks/:id/image            -> the task's photo (bytes)
//   POST /api/tasks/:id/viewed           -> marks a human has opened it
//   POST /api/tasks/vision?title=&note=  -> raw image body -> 201 { id }

import fs from "node:fs";
import {
  listTaskDetails,
  getTaskDetail,
  markTaskViewed,
  taskImageInfo,
  createVisionTask,
  DelegateTaskError,
  MAX_TASK_IMAGE_BYTES,
} from "./delegatedTasks.js";
import { log } from "./logger.js";

// A little headroom over the image cap so an exactly-at-limit image isn't
// refused by the body reader before createVisionTask can apply its own check.
export const MAX_TASK_UPLOAD_BYTES = MAX_TASK_IMAGE_BYTES + 4096;

const TASK_ID = /^t-[a-z0-9-]+$/;

export class TaskApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Raw (non-JSON) body reader with a hard cap, same shape as server.js's
// readJsonBody. Rejects with a 413 TaskApiError past the cap instead of
// buffering an unbounded upload.
export function readRawBody(req, maxBytes = MAX_TASK_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new TaskApiError(413, "body too large"));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(status, body) {
  return { status, json: body };
}

// Returns null when the path isn't ours (caller falls through), otherwise a
// plain result object — { status, json } or { status, file: { path, mimeType } }
// — so this never touches `res` and is trivially testable. Never throws.
export async function handleTasksApi({ method, pathname, query, readBody }) {
  if (pathname !== "/api/tasks" && !pathname.startsWith("/api/tasks/")) return null;
  const parts = pathname.split("/").filter(Boolean); // ["api","tasks", id?, action?]
  const [, , id, action] = parts;

  try {
    if (!id) {
      if (method === "GET") return json(200, { tasks: listTaskDetails() });
      return json(405, { error: "method not allowed" });
    }

    if (id === "vision") {
      if (action || method !== "POST") return json(action ? 404 : 405, { error: action ? "not found" : "method not allowed" });
      const image = await readBody();
      const { id: newId } = createVisionTask({
        title: query?.get("title") ?? undefined,
        note: query?.get("note") ?? undefined,
        image,
      });
      return json(201, { id: newId });
    }

    if (!TASK_ID.test(id)) return json(404, { error: "not found" });

    if (!action && method === "GET") {
      const task = getTaskDetail(id);
      return task ? json(200, task) : json(404, { error: "not found" });
    }
    if (action === "image" && method === "GET") {
      const info = taskImageInfo(id);
      return info ? { status: 200, file: info } : json(404, { error: "not found" });
    }
    if (action === "viewed" && method === "POST") {
      const task = markTaskViewed(id);
      return task ? json(200, task) : json(404, { error: "not found" });
    }
    return json(action || method === "GET" ? 404 : 405, { error: action || method === "GET" ? "not found" : "method not allowed" });
  } catch (err) {
    if (err instanceof TaskApiError) return json(err.status, { error: err.message });
    if (err instanceof DelegateTaskError) return json(400, { error: err.message });
    log("tasks api request failed", { path: pathname, error: err?.message ?? String(err) });
    return json(500, { error: "request failed" });
  }
}

// Writes a handleTasksApi result to a node http response. Image bytes are
// read whole (capped at MAX_TASK_IMAGE_BYTES on the way in) rather than
// streamed, so a file removed mid-request is a clean 404, not a torn response.
export async function sendTasksApiResult(res, result) {
  if (result.file) {
    let data;
    try {
      data = await fs.promises.readFile(result.file.path);
    } catch {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": result.file.mimeType,
      "Content-Length": data.length,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
    return;
  }
  sendJson(res, result.status, result.json);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}
