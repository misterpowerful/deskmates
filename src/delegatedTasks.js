// Async task delegation (friendly mode only — see CAPABILITIES.md). A
// substantial request ("summarize my unread emails", "add this to my
// calendar", "research X") gets handed to a background worker instead of
// run live: this module stores the task, spawns a headless `claude -p`
// subprocess (never the Agent SDK, never ANTHROPIC_API_KEY — see
// scrubAnthropicEnv below) to actually do the work, parses its final JSON
// answer, and notifies the physical bot so it can play a completion chime.
//
// Storage: delegated-tasks/t-<id>.json, one file per task, gitignored and
// chmod 700 (can contain email content) — deliberately NOT inside tasks/,
// which is the git-tracked self-improvement build queue (tasks/pending/,
// done/, failed/, proposed/, rejected/); mixing a gitignored,
// permission-locked, PII-bearing file into that tree would conflict with
// both its git tracking and its own directory permissions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { log, logError } from "./logger.js";
import { sendOrQueueBotFrame } from "./robotLink.js";
import { broadcastToConsoles } from "./consoleLink.js";

const ROOT = process.cwd();
export const DELEGATED_TASKS_DIR = path.join(ROOT, "delegated-tasks");

// Cron runs with a bare PATH that doesn't include the claude CLI's install
// location — same issue and same fix as scripts/run-build-task.js's
// CLAUDE_BIN, and the same env var name/override so an operator (or a test)
// only ever needs to know one knob.
const CLAUDE_BIN = () => process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");

const MAX_TITLE_CHARS = 200;
const MAX_REQUEST_CHARS = 20_000;

function workerMaxTurns() {
  return Number(process.env.WORKER_MAX_TURNS) || 15;
}
function workerTimeoutMs() {
  return Number(process.env.WORKER_TIMEOUT_MS) || 5 * 60 * 1000;
}
function workerConcurrency() {
  return Number(process.env.WORKER_CONCURRENCY) || 2;
}
export function taskRetentionDays() {
  return Number(process.env.TASK_RETENTION_DAYS) || 7;
}

// Gmail/Drive tool names confirmed against this account's actually-connected
// MCP connectors (see README's "Async task delegation" section); the
// Calendar connector was not authorized at the time this was written, so
// those two names are a best guess at the same `mcp__claude_ai_Google_
// Calendar__*` naming convention, not confirmed — override with
// WORKER_ALLOWED_TOOLS (comma-separated) once Calendar is authorized and the
// real names are known, or if any connector is renamed. An unmatched name is
// harmless: --allowedTools silently grants nothing for it rather than erroring.
const DEFAULT_ALLOWED_TOOLS = [
  "WebSearch",
  "WebFetch",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_message",
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Drive__read_file_content",
  "mcp__claude_ai_Google_Drive__create_file",
];

function workerAllowedTools() {
  const override = process.env.WORKER_ALLOWED_TOOLS;
  if (typeof override === "string" && override.trim()) {
    return override
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED_TOOLS;
}

// The only two vars in this codebase that can make a Claude Code subprocess
// bill against the Anthropic API instead of the subscription OAuth token —
// same two stripped by speechPipeline.js's claudeCodeAuthEnv for the
// deep_thoughtful/claude-code path. CLAUDE_CODE_OAUTH_TOKEN is deliberately
// NOT touched: that's the credential this is trying to protect, not
// scrub. Returns a fresh object; never mutates process.env.
export function scrubAnthropicEnv(env = process.env) {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = env;
  return rest;
}

let counter = 0;
function makeTaskId() {
  return `t-${Date.now().toString(36)}-${++counter}`;
}

function taskPath(id) {
  return path.join(DELEGATED_TASKS_DIR, `${id}.json`);
}

// Idempotent; safe to call on every write, not just at boot.
export function ensureDelegatedTasksDir() {
  fs.mkdirSync(DELEGATED_TASKS_DIR, { recursive: true });
  fs.chmodSync(DELEGATED_TASKS_DIR, 0o700);
}

// tmp + rename, same pattern as longTermMemory.js's appendMemoryFact — a
// crash mid-write can't leave a truncated/corrupt task file behind.
function writeTaskFile(task) {
  ensureDelegatedTasksDir();
  const filePath = taskPath(task.id);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

// Null on anything short of a well-formed task object — missing file,
// unparseable JSON, or JSON that isn't the expected shape — so a corrupt or
// half-written file degrades to "not found" for every caller rather than
// throwing mid-conversation.
export function readTask(id) {
  if (typeof id !== "string" || path.basename(id) !== id) return null;
  let raw;
  try {
    raw = fs.readFileSync(taskPath(id), "utf8");
  } catch {
    return null;
  }
  try {
    const task = JSON.parse(raw);
    if (!task || typeof task !== "object" || typeof task.id !== "string") return null;
    return task;
  } catch {
    return null;
  }
}

function listAllTasks() {
  if (!fs.existsSync(DELEGATED_TASKS_DIR)) return [];
  return fs
    .readdirSync(DELEGATED_TASKS_DIR)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => readTask(name.slice(0, -".json".length)))
    .filter(Boolean);
}

// Newest first. [{id, title, status}] only — summary/result/request never
// leave this function, matching the list_tasks tool contract (title/status
// only; get_task_result is the one path to a summary, and only a summary).
export function listTasks({ includeHeard = false } = {}) {
  return listAllTasks()
    .filter((t) => includeHeard || !t.heard)
    .sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));
}

export function countUnheardTasks() {
  return listAllTasks().filter((t) => !t.heard).length;
}

// { title, status, summary } only — result (the full output) never goes
// over this path; get_task_result is the spoken-summary tool, not a way to
// retrieve the raw worker output. Marks the task heard as a side effect,
// same request that read it. Returns null for an unknown id.
export function getTaskResult(id) {
  const task = readTask(id);
  if (!task) return null;
  if (!task.heard) {
    writeTaskFile({ ...task, heard: true });
  }
  return { title: task.title, status: task.status, summary: task.summary };
}

// Two independent channels, neither affecting the other: the physical bot's
// chime (queued if it's offline — see sendOrQueueBotFrame) and a webapp/
// console toast (missed outright if nobody's connected — see
// broadcastToConsoles). Both read-only off `task`, which runWorker always
// builds internally, never from unvalidated tool input — createDelegatedTask
// is the one path that validates hostile input, and it's untouched by this.
function notifyTaskDone(task) {
  sendOrQueueBotFrame({ type: "task_done", task_id: task.id, status: task.status });
  broadcastToConsoles({ type: "task_notification", task_id: task.id, title: task.title, status: task.status });
}

// Module-level: a handful of background workers per server process, not
// per-connection — delegated tasks are global/server-scoped (a single-owner
// home robot), independent of which connection or conversation created them.
const pendingQueue = [];
let activeCount = 0;

function pump() {
  while (activeCount < workerConcurrency() && pendingQueue.length > 0) {
    const task = pendingQueue.shift();
    activeCount += 1;
    runWorker(task)
      .catch((err) => {
        // runWorker is written to never reject (every internal failure is
        // caught and turned into a "failed" task) — this is only a backstop
        // against a genuinely unexpected bug, so the queue can't wedge.
        logError("delegated task: worker run threw unexpectedly", {
          id: task.id,
          error: err?.message ?? String(err),
        });
      })
      .finally(() => {
        activeCount -= 1;
        pump();
      });
  }
}

function buildWorkerPrompt(request) {
  return `You are a background worker for Deskmates, a home voice assistant. A person asked the assistant to delegate the following piece of work to you — do it, then stop:

${request}

You have web search/fetch and read-only or draft-only Gmail, Google Calendar, and Google Drive tools. You may read, search, and create drafts/events/files as needed, but you must NEVER actually send an email, delete anything, or spend money — if the work calls for one of those, prepare it (e.g. a Gmail draft, a described-but-uncreated purchase) and report it as needing sign-off instead of completing it, via needs_confirmation below.

When you are completely finished, your FINAL message must be ONLY a single JSON object — no markdown code fence, no text before or after it — of this exact shape:
{"summary": "<ONE or TWO plain sentences, no markdown, written to be read aloud exactly as-is>", "result": "<the full output/detail, as long as actually needed, not spoken aloud>", "needs_confirmation": <true if you prepared something that needs the person's explicit sign-off before it can go out, false otherwise>}`;
}

// Never throws and never rejects: spawn failures (missing binary, timeout,
// a non-JSON stdout) all resolve to a plain result object the caller
// branches on, same "errors are data, not exceptions" convention as
// runCustomTool / condenseAndStore elsewhere in this codebase.
export function spawnClaudeWorker({
  prompt,
  maxTurns = workerMaxTurns(),
  timeoutMs = workerTimeoutMs(),
  allowedTools = workerAllowedTools(),
  claudeBin = CLAUDE_BIN(),
  env = scrubAnthropicEnv(),
  spawnFn = spawn,
}) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--max-turns",
      String(maxTurns),
      "--allowedTools",
      allowedTools.join(","),
    ];

    let child;
    try {
      child = spawnFn(claudeBin, args, { cwd: os.tmpdir(), env });
    } catch (err) {
      resolve({ stdout: "", stderr: "", timedOut: false, exitCode: null, spawnError: err?.message ?? String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ stdout, stderr, timedOut, exitCode: null, spawnError: err?.message ?? String(err) });
    });
    child.on("close", (exitCode) => {
      finish({ stdout, stderr, timedOut, exitCode });
    });
  });
}

const MAX_FAILURE_REASON_CHARS = 200;
function shortReason(text) {
  const t = String(text ?? "").trim() || "unknown error";
  return t.length > MAX_FAILURE_REASON_CHARS ? `${t.slice(0, MAX_FAILURE_REASON_CHARS)}...` : t;
}

// Two layers of JSON to unwrap: the CLI's own `--output-format json`
// envelope ({ is_error, result, ... } — result is the final assistant
// message as plain text), and inside that, the { summary, result,
// needs_confirmation } object buildWorkerPrompt instructed the worker to
// answer with. Either layer failing to parse is a failed task, not a crash —
// same graceful-degradation contract as parseDeepThoughtfulOutput.
export function parseWorkerOutput(spawnResult) {
  if (spawnResult.spawnError) {
    return { ok: false, reason: shortReason(`claude invocation failed: ${spawnResult.spawnError}`) };
  }
  if (spawnResult.timedOut) {
    return { ok: false, reason: "Worker timed out before finishing." };
  }

  let envelope;
  try {
    envelope = JSON.parse(spawnResult.stdout);
  } catch {
    return { ok: false, reason: "Worker produced no readable output." };
  }
  if (envelope?.is_error) {
    return { ok: false, reason: shortReason(envelope.result || spawnResult.stderr || "claude reported an error") };
  }
  if (typeof envelope?.result !== "string") {
    return { ok: false, reason: "Worker finished with no result." };
  }

  let inner;
  try {
    const stripped = envelope.result.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    inner = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: "Worker did not return a valid result." };
  }
  if (typeof inner?.summary !== "string" || !inner.summary.trim() || typeof inner?.result !== "string") {
    return { ok: false, reason: "Worker's result was missing a summary." };
  }

  return {
    ok: true,
    summary: inner.summary.trim(),
    result: inner.result,
    needsConfirmation: Boolean(inner.needs_confirmation),
  };
}

async function runWorker(task) {
  let outcome;
  try {
    const spawnResult = await spawnClaudeWorker({ prompt: buildWorkerPrompt(task.request) });
    outcome = parseWorkerOutput(spawnResult);
  } catch (err) {
    // Backstop only — spawnClaudeWorker/parseWorkerOutput are written not to
    // throw, same reasoning as the pump()-level catch above.
    outcome = { ok: false, reason: shortReason(err?.message ?? String(err)) };
  }

  const completed = new Date().toISOString();
  const updated = outcome.ok
    ? {
        ...task,
        status: outcome.needsConfirmation ? "needs_confirmation" : "done",
        summary: outcome.summary,
        result: outcome.result,
        completed,
      }
    : { ...task, status: "failed", summary: outcome.reason, result: null, completed };

  writeTaskFile(updated);
  log("delegated task: worker finished", { id: task.id, status: updated.status });
  notifyTaskDone(updated);
}

// Loosely matches the explicit "delegate this"/"hand this off" trigger
// (CAPABILITIES.md's async task delegation section): anchored at the start
// of the transcript (not a substring match anywhere, unlike
// DEEP_THOUGHTFUL_TRIGGERS — an explicit hand-off phrase mid-sentence isn't
// the same signal as it opening the utterance), case-insensitive, tolerant
// of leading quote/whitespace characters an STT pass can introduce and a
// trailing comma/colon/dash after the phrase itself. Returns the instruction
// (everything after the phrase, trimmed of leading punctuation) or null if
// nothing followed — an empty instruction can't be delegated, same "treat as
// not-a-trigger" rule stripDeepThoughtfulPrefix uses for a bare "dt:".
const EXPLICIT_DELEGATE_PHRASES = ["delegate this", "delegate that", "hand this off", "hand that off"];

export function matchExplicitDelegate(transcript) {
  const trimmed = String(transcript ?? "").replace(/^[\s"'‘’“”]+/, "");
  const lower = trimmed.toLowerCase();
  for (const phrase of EXPLICIT_DELEGATE_PHRASES) {
    if (!lower.startsWith(phrase)) continue;
    const instruction = trimmed.slice(phrase.length).replace(/^[\s,:;.\-—]+/, "").trim();
    if (!instruction) return null;
    return { phrase, instruction };
  }
  return null;
}

export class DelegateTaskError extends Error {}

// Shared by the automatic delegate_task tool (src/tools/index.js) and the
// explicit "delegate this"/"hand this off" path in speechPipeline.js —
// either way a task is created identically: written to disk synchronously
// (so {id} is valid the instant this returns) and its worker started
// without being awaited, so the caller can speak an ack line immediately
// while the work runs in the background.
export function createDelegatedTask({ title, request }) {
  if (typeof title !== "string" || !title.trim()) {
    throw new DelegateTaskError("title is required and must be a non-empty string");
  }
  if (typeof request !== "string" || !request.trim()) {
    throw new DelegateTaskError("request is required and must be a non-empty string");
  }
  if (title.length > MAX_TITLE_CHARS) {
    throw new DelegateTaskError(`title must be at most ${MAX_TITLE_CHARS} characters`);
  }
  if (request.length > MAX_REQUEST_CHARS) {
    throw new DelegateTaskError(`request must be at most ${MAX_REQUEST_CHARS} characters`);
  }

  const task = {
    id: makeTaskId(),
    title: title.replace(/\s+/g, " ").trim(),
    request: request.trim(),
    status: "running",
    created: new Date().toISOString(),
    completed: null,
    summary: null,
    result: null,
    heard: false,
  };
  writeTaskFile(task);
  log("delegated task: created", { id: task.id, title: task.title });

  pendingQueue.push(task);
  pump();

  return { id: task.id };
}

// Startup-only: a task file still saying "running" can only mean the worker
// that was going to finish it died with the previous process (there is no
// disk-backed resume for an in-flight `claude -p` call) — surface that as a
// failure rather than leaving it stuck "running" forever with no worker
// ever coming back to it.
export function reconcileOrphanedTasks() {
  const completed = new Date().toISOString();
  for (const task of listAllTasks()) {
    if (task.status !== "running") continue;
    writeTaskFile({
      ...task,
      status: "failed",
      summary: "Interrupted by a server restart before it finished.",
      result: null,
      completed,
    });
    log("delegated task: reconciled orphaned running task as failed", { id: task.id });
  }
}

// Deletes heard=true tasks whose completed (falling back to created, for the
// rare heard-while-still-running case) is older than retentionDays. Run at
// startup and hourly (server.js) — never deletes an unheard task, however
// old, since that's the one copy of a result nobody's listened to yet.
export function sweepRetention(now = Date.now(), retentionDays = taskRetentionDays()) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const task of listAllTasks()) {
    if (!task.heard) continue;
    const ageSource = task.completed ?? task.created;
    const ageMs = Date.parse(ageSource ?? "");
    if (!Number.isFinite(ageMs) || ageMs >= cutoff) continue;
    try {
      fs.unlinkSync(taskPath(task.id));
      removed += 1;
    } catch (err) {
      logError("delegated task: retention sweep failed to remove a task file", {
        id: task.id,
        error: err?.message ?? String(err),
      });
    }
  }
  if (removed > 0) log("delegated task: retention sweep removed tasks", { removed, retentionDays });
  return removed;
}
