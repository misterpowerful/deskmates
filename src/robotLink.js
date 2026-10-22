// Link to the physical desk robot (the firmware client: any non-console WebSocket connection).
// Gatsby drives the robot through a tool (robot_find_me) that sends a robot_command frame; the
// bot runs the matching built-in routine after his reply has played and answers with a
// robot_result frame, which handleRobotResult in server.js turns into a spoken reaction.

import { log, logError } from "./logger.js";

const botSockets = new Set();
const pending = new Map(); // command id -> { action, startedAt, ws, timer }
let counter = 0;

// CAPABILITIES.md documents the sweep as taking "up to about half a
// minute"; this is a generous ceiling above that so a slow-but-alive sweep
// isn't mistaken for a dead one.
export const ROBOT_COMMAND_TIMEOUT_MS = 90_000;

// Set once by server.js so a timed-out command can still be announced to
// whoever's conversation is waiting on it, without robotLink.js (which
// stays server-agnostic otherwise) importing server.js back.
let timeoutHandler = null;

export function setRobotCommandTimeoutHandler(handler) {
  timeoutHandler = handler;
}

function expireCommand(id) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  log("robot command timed out", { id, action: entry.action });
  try {
    timeoutHandler?.(entry.ws, id, entry);
  } catch (err) {
    // A timer callback throwing would otherwise be an unhandled exception
    // (this doesn't run inside anything that could catch it) and take the
    // whole process down over what should just be a missed announcement.
    logError("robot command timeout handler failed", { id, error: err?.message });
  }
}

// ws.readyState 1 === OPEN
function connectedBot() {
  for (const ws of botSockets) {
    if (ws.readyState === 1) return ws;
  }
  return null;
}

export function registerRobotSocket(ws, flushOptions) {
  if (!ws.isConsoleClient) {
    botSockets.add(ws);
    flushPendingBotFrames(flushOptions);
  }
}

export function unregisterRobotSocket(ws) {
  botSockets.delete(ws);
  for (const [id, entry] of pending) {
    if (entry.ws !== ws) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    log("robot command orphaned by disconnect", { id, action: entry.action });
  }
}

export function isRobotConnected() {
  return connectedBot() !== null;
}

// Returns the command id, or null when no bot is connected.
export function sendRobotCommand(action, timeoutMs = ROBOT_COMMAND_TIMEOUT_MS) {
  const ws = connectedBot();
  if (!ws) return null;
  const id = `r-${Date.now().toString(36)}-${++counter}`;
  ws.send(JSON.stringify({ type: "robot_command", id, action }));
  const timer = setTimeout(() => expireCommand(id), timeoutMs);
  timer.unref?.();
  pending.set(id, { action, startedAt: Date.now(), ws, timer });
  log("robot command sent", { id, action });
  return id;
}

// Consumes the pending entry for id; null if unknown (stale, never sent, or
// already timed out/orphaned).
export function takeRobotCommand(id) {
  const entry = pending.get(id) ?? null;
  if (entry) clearTimeout(entry.timer);
  pending.delete(id);
  return entry;
}

const OUTCOME_TEXT = {
  found: "it found a person and drove up to them",
  not_found: "it turned all the way around and saw no one",
  charging: "it couldn't move because it's on the charger",
  unsafe: "it couldn't move: it isn't upright on the floor, or something is right in front of it",
  interrupted: "it stopped part-way because something blocked it",
  error: "something went wrong on the robot",
  timeout: "it never reported back — contact with the robot was lost, so the outcome is unknown",
};

// Plain-English summary of a robot_result (or a synthetic timeout) for the model.
export function describeRobotResult(msg) {
  const what = OUTCOME_TEXT[msg.outcome] ?? `it reported "${msg.outcome}"`;
  let who = "";
  if (msg.outcome === "found") {
    if (msg.owner_recognized) who = " It recognized the face as the owner's.";
    else if (msg.owner_enrolled) who = " The face did not match the owner's enrolled face (someone else, or a poor view).";
    else who = " It can't confirm who it is: no owner face is enrolled on the robot yet.";
  }
  return `your robot body just finished searching for the owner: ${what}.${who}`;
}

// Wraps describeRobotResult into the full report text server.js feeds through
// runTextPipeline for a robot_result or a synthetic timeout alike.
export function buildRobotAnnouncementReport(msg) {
  return (
    `(Robot report, not something the owner said.) ${describeRobotResult(msg)} ` +
    "React to the owner in one short spoken line, in character."
  );
}

// Generic, non-robot_command notification channel to the physical bot (used
// by src/delegatedTasks.js's task_done frame) — unlike sendRobotCommand,
// this never expects a reply and has no pending/timeout bookkeeping. Queued
// rather than dropped when no bot is connected, so a task that finishes
// while the robot is mid-reconnect or powered off still gets its chime once
// it's back, instead of the person never finding out without asking.
//
// Both bounded, mirroring delegatedTasks.js's TASK_RETENTION_DAYS: a frame
// that's waited this long is old enough that its task may already have aged
// out of delegated-tasks/ entirely, so it's dropped instead of fired; the
// count cap exists independently so a robot that stays offline for a very
// long time (days, powered off) can't grow the queue without bound even
// before any single frame is old enough to expire.
export const PENDING_BOT_FRAME_MAX_AGE_MS = (Number(process.env.TASK_RETENTION_DAYS) || 7) * 24 * 60 * 60 * 1000;
export const PENDING_BOT_FRAME_MAX_COUNT = 50;

const pendingBotFrames = []; // { frame, queuedAt }

// Trims expired entries off the front, then enforces the count cap (also
// oldest-first). Hostile/garbage limits fall back to the real defaults
// rather than disabling the cap or looping forever.
function dropStalePendingBotFrames(maxAgeMs, maxCount) {
  const safeMaxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : PENDING_BOT_FRAME_MAX_AGE_MS;
  const safeMaxCount = Number.isInteger(maxCount) && maxCount >= 0 ? maxCount : PENDING_BOT_FRAME_MAX_COUNT;
  const now = Date.now();
  while (pendingBotFrames.length > 0 && now - pendingBotFrames[0].queuedAt > safeMaxAgeMs) {
    const dropped = pendingBotFrames.shift();
    log("bot frame dropped from queue (expired)", { type: dropped.frame?.type });
  }
  while (pendingBotFrames.length > safeMaxCount) {
    const dropped = pendingBotFrames.shift();
    log("bot frame dropped from queue (queue full)", { type: dropped.frame?.type });
  }
}

function flushPendingBotFrames({ maxAgeMs = PENDING_BOT_FRAME_MAX_AGE_MS, maxCount = PENDING_BOT_FRAME_MAX_COUNT } = {}) {
  if (pendingBotFrames.length === 0) return;
  const ws = connectedBot();
  if (!ws) return;
  dropStalePendingBotFrames(maxAgeMs, maxCount);
  for (const { frame } of pendingBotFrames.splice(0)) {
    ws.send(JSON.stringify(frame));
    log("bot frame sent (from queue)", { type: frame.type });
  }
}

export function sendOrQueueBotFrame(frame, { maxAgeMs = PENDING_BOT_FRAME_MAX_AGE_MS, maxCount = PENDING_BOT_FRAME_MAX_COUNT } = {}) {
  const ws = connectedBot();
  if (ws) {
    ws.send(JSON.stringify(frame));
    log("bot frame sent", { type: frame.type });
    return true;
  }
  pendingBotFrames.push({ frame, queuedAt: Date.now() });
  dropStalePendingBotFrames(maxAgeMs, maxCount);
  log("bot frame queued (no bot connected)", { type: frame?.type });
  return false;
}
