import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeTaskFile, appendNote } from "./taskFile.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

export const GATSBY_CONVERSATION_SOURCE = "gatsby-conversation";
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 20_000;

// Commits just the one new task file. The nightly build works off git's
// `main` ref via a worktree, not the live working tree, so an uncommitted
// task would be invisible to it. Resolves true/false, never rejects.
async function commitTaskFile(root, filePath, title) {
  const relPath = path.relative(root, filePath);
  try {
    await execFileAsync("git", ["add", "-A", "--", relPath], { cwd: root });
    await execFileAsync("git", ["commit", "-m", `Add self-authored task (conversation): ${title}`, "--", relPath], { cwd: root });
    return true;
  } catch (err) {
    log("task queue: git commit for queued task failed", { file: relPath, error: err?.message ?? String(err) });
    return false;
  }
}

// Writes a task straight into tasks/pending/ (no approval step) and commits
// it. The file write is synchronous, so it exists when this returns; `committed`
// resolves once the commit attempt finishes, so callers that don't need to wait
// (the spoken-reply path) can ignore it. Throws on an invalid title/description.
export function queueTask(root, { title, description }, { source = GATSBY_CONVERSATION_SOURCE } = {}) {
  if (typeof title !== "string" || !title.trim()) throw new Error("title is required and must be a non-empty string");
  if (typeof description !== "string" || !description.trim()) throw new Error("description is required and must be a non-empty string");
  if (title.length > MAX_TITLE_CHARS) throw new Error(`title must be at most ${MAX_TITLE_CHARS} characters`);
  if (description.length > MAX_DESCRIPTION_CHARS) throw new Error(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);

  const { filePath, filename } = writeTaskFile(path.join(root, "tasks", "pending"), { source, title, description });
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  return { filePath, filename, committed: commitTaskFile(root, filePath, cleanTitle) };
}

// propose_task (deepThoughtful.js) lands directly in tasks/pending/ — no
// approve-task step, unlike run-ideation.js's tasks/proposed/ flow (see
// CAPABILITIES.md). The file write is synchronous so it exists by the time
// this returns; the git commit runs in the background so it never delays
// the spoken reply. Never throws: a failure here shouldn't cost the person
// their answer, just the (logged) proposal.
export function writeSelfAuthoredTask(proposedTask) {
  try {
    const { filename } = queueTask(process.cwd(), proposedTask);
    log("deep_thoughtful: wrote self-authored task", { filename, title: proposedTask.title });
  } catch (err) {
    log("deep_thoughtful: failed to write self-authored task", {
      title: proposedTask?.title,
      error: err?.message ?? String(err),
    });
  }
}

export class RejectTaskError extends Error {}

// Moves a task out of the build queue into tasks/rejected/, optionally
// recording why, and commits the move. Shared by scripts/reject-task.js
// (the CLI) and the queue drawer's POST /api/queue/reject endpoint, so a
// task rejected either way is rejected identically — including the git
// commit. Checks tasks/proposed/ (an ideation idea awaiting approval)
// before tasks/pending/, matching the CLI's long-standing behavior. Throws
// RejectTaskError for a bad filename or a task that isn't there to reject;
// a git failure throws the raw error so callers can tell "nothing to
// reject" (400-shaped) apart from "couldn't commit" (500-shaped).
export function rejectTask(root, filename, reason) {
  if (typeof filename !== "string" || filename === "" || path.basename(filename) !== filename) {
    throw new RejectTaskError("filename must be a bare filename");
  }
  const rejectedDir = path.join(root, "tasks", "rejected");
  const fromDir = fs.existsSync(path.join(root, "tasks", "proposed", filename))
    ? "proposed"
    : fs.existsSync(path.join(root, "tasks", "pending", filename))
      ? "pending"
      : null;
  if (!fromDir) {
    throw new RejectTaskError(`No such task at tasks/proposed/${filename} or tasks/pending/${filename}`);
  }
  const srcPath = path.join(root, "tasks", fromDir, filename);
  const destPath = path.join(rejectedDir, filename);
  if (fs.existsSync(destPath)) {
    throw new RejectTaskError(`A task already exists at tasks/rejected/${filename}`);
  }

  fs.mkdirSync(rejectedDir, { recursive: true });
  let raw = fs.readFileSync(srcPath, "utf8");
  if (reason) {
    raw = appendNote(raw, "Rejected", reason);
    fs.writeFileSync(srcPath, raw);
  }
  fs.renameSync(srcPath, destPath);

  const addPaths = ["tasks/proposed", "tasks/pending", "tasks/rejected"].filter((rel) =>
    fs.existsSync(path.join(root, rel)),
  );
  execFileSync("git", ["add", "-A", "--", ...addPaths], { cwd: root });
  execFileSync("git", ["commit", "-m", `Reject task: ${filename}${reason ? ` — ${reason}` : ""}`], { cwd: root });

  return { filename, fromDir };
}
