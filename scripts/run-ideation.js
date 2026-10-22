import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { log } from "../src/logger.js";
import { listTaskFiles, readTaskFile } from "../src/taskFile.js";
import { validateTaskFile } from "../src/dataValidation.js";

// Cron runs with a bare PATH (/usr/bin:/bin) that doesn't include the
// claude CLI's install location, so a plain "claude" lookup fails with
// ENOENT there even though it resolves fine in an interactive shell.
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");

// Daily cron job: asks Claude Code to look at its own repo and propose 1-3
// concrete improvements as new files under tasks/pending/, i.e. straight into
// the build queue (no approval step). Never writes source code itself, and
// the invoked Claude session is permission-scoped so IT can't either —
// read-only on the repo, write access confined to tasks/pending/. The owner can
// still pull one before the nightly build with npm run reject-task.
//
// Usage: node scripts/run-ideation.js   (cron: 0 2 * * *)

const ROOT = process.cwd();
const CAPABILITIES_PATH = path.join(ROOT, "CAPABILITIES.md");
const PENDING_DIR = path.join(ROOT, "tasks", "pending");
const PROPOSED_DIR = path.join(ROOT, "tasks", "proposed");
const FAILED_DIR = path.join(ROOT, "tasks", "failed");
const DONE_DIR = path.join(ROOT, "tasks", "done");
const REJECTED_DIR = path.join(ROOT, "tasks", "rejected");
const LOGS_DIR = path.join(ROOT, "logs");

// Generous but bounded — this must never hang the daily cron slot forever.
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

// The invoked session gets full read access to the repo (Read/Glob/Grep,
// plus a read-only slice of Bash for git history) but Edit is scoped to
// tasks/pending/ only — verified empirically: Claude Code's path-scoping
// (`Tool(glob)`) works for Edit, NOT for Write, and Edit can create a new
// file at a path that doesn't exist yet, which is all this job needs.
const ALLOWED_TOOLS =
  "Read,Glob,Grep,Bash(git log *),Bash(git show *),Bash(git diff *),Edit(tasks/pending/**)";

function log_(...args) {
  log(...args);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function summarizeTasks(dir) {
  return listTaskFiles(dir).map((t) => ({
    filename: t.filename,
    title: t.frontmatter.title ?? t.filename,
    // Rejected tasks have their reason appended by reject-task.js as a
    // "---\nRejected: <reason>" trailer — surface it so the ideation job
    // understands *why* something was declined, not just that it was.
    note: /\n---\nRejected: /.test(t.body)
      ? t.body.slice(t.body.lastIndexOf("---\nRejected: "))
      : undefined,
    // Failed tasks get a "---\nFailed: <reason>" trailer from run-build-task.js.
    failure: /\n---\nFailed: /.test(t.body)
      ? t.body.slice(t.body.lastIndexOf("---\nFailed: ") + "---\nFailed: ".length).trim()
      : undefined,
  }));
}

function buildPrompt({ capabilities, done, rejected, pending, proposed, failed }) {
  const doneList = done.length
    ? done.map((t) => `- ${t.title} (${t.filename})`).join("\n")
    : "(nothing yet)";
  const pendingList = pending.length
    ? pending.map((t) => `- ${t.title} (${t.filename})`).join("\n")
    : "(nothing)";
  const proposedList = proposed.length
    ? proposed.map((t) => `- ${t.title} (${t.filename})`).join("\n")
    : "(nothing)";
  const failedList = failed.length
    ? failed
        .map(
          (t) =>
            `- ${t.title} (${t.filename}) — failure reason: ${
              t.failure ? t.failure.replace(/\s+/g, " ").slice(0, 300) : "(not recorded)"
            }`,
        )
        .join("\n")
    : "(nothing)";
  const rejectedList = rejected.length
    ? rejected
        .map((t) => `- ${t.title} (${t.filename})${t.note ? ` — ${t.note.replace(/\n/g, " ")}` : ""}`)
        .join("\n")
    : "(nothing yet)";

  return `You are looking at your own codebase — a Node.js WebSocket backend for a home robot personality named Gatsby ("Deskmates") — to propose ideas for how to improve it.

Read CAPABILITIES.md (reproduced below) first, then actually explore the repo yourself (server.js, src/, personalities/, scripts/, data/phrase-manifest.json, README.md, WEBAPP.md, webapp/) before proposing anything — don't rely on the summary alone, it may be stale.

=== CAPABILITIES.md ===
${capabilities}
=== end CAPABILITIES.md ===

Ideas already built (do NOT re-propose these):
${doneList}

Ideas already queued to build (do NOT re-propose these):
${pendingList}

Ideas already proposed and awaiting review (do NOT re-propose these):
${proposedList}

Ideas already attempted that failed, with the recorded failure reason:
${failedList}

Guidance on failed ideas: don't blindly re-propose them. If the failure reason was mechanical (e.g. "claude invocation failed" / ENOENT, a broken PATH, a timeout, a transient health-check failure — tooling problems rather than bad ideas), the underlying goal may still be worth pursuing, so a genuinely different approach to it is allowed. If the failure reveals a real dead end (the approach can't work, or conflicts with the codebase), don't propose it again.

Ideas already declined by the owner (do NOT re-propose these — read the reason where given, it tells you why):
${rejectedList}

Your job: propose 1 to 3 concrete, genuinely useful improvements that are NOT already built and NOT already declined. Good ideas are specific and scoped enough that a single build pass could plausibly implement them in one sitting — not vague aspirations like "improve reliability." Look for real gaps: missing error handling, an underused capability, a rough edge in the canned-response/memory/personality system, tooling, observability, a new small feature.

For each idea, create a new file at tasks/pending/<slug>-<unix-timestamp>.md with EXACTLY this format:

---
source: gatsby
created: <ISO 8601 timestamp>
title: <short title>
---

<Free-text description of what to build/fix and why it's worth doing.>

You have READ access to the whole repo but WRITE access ONLY to tasks/pending/ (files there are built automatically overnight, so only propose things you are confident are worth building) — do not attempt to modify any other file (it will be denied anyway). If, after genuinely exploring, you don't find anything worth proposing that isn't already built or already rejected, that is a valid outcome: say so in your final reply and don't create any files. Quality over quantity — one good idea beats three forced ones.`;
}

function invokeClaude(prompt) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--allowedTools",
    ALLOWED_TOOLS,
  ];
  // Strip Anthropic credentials from the child environment. dotenv/config
  // (imported at the top of this file for the bot's own API keys) puts
  // ANTHROPIC_API_KEY into process.env, and Claude Code prefers an API key
  // over the logged-in subscription — so without this, every ideation run
  // bills per-token to the API key instead of the Pro/Max plan.
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env;
  const stdout = execFileSync(CLAUDE_BIN, args, {
    cwd: ROOT,
    env,
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function writeLog(entry) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `self-ideation-${timestamp()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
  log_(`Wrote ideation log to ${path.relative(ROOT, logPath)}`);
}

function main() {
  const capabilities = fs.existsSync(CAPABILITIES_PATH)
    ? fs.readFileSync(CAPABILITIES_PATH, "utf8")
    : "(CAPABILITIES.md not found)";
  const done = summarizeTasks(DONE_DIR);
  const rejected = summarizeTasks(REJECTED_DIR);
  const pending = summarizeTasks(PENDING_DIR);
  // Gathered before the Claude run so files created by this run aren't fed back.
  const proposed = summarizeTasks(PROPOSED_DIR);
  const failed = summarizeTasks(FAILED_DIR);

  const before = new Set(fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR) : []);

  const prompt = buildPrompt({ capabilities, done, rejected, pending, proposed, failed });

  let result;
  try {
    result = invokeClaude(prompt);
  } catch (err) {
    log_("run-ideation: claude invocation failed", { error: err?.message ?? String(err) });
    writeLog({
      timestamp: new Date().toISOString(),
      outcome: "error",
      error: err?.message ?? String(err),
    });
    process.exit(1);
  }

  const after = fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR) : [];
  const createdFiles = after.filter((name) => !before.has(name) && name.endsWith(".md"));

  // Light gate: a task file that fails validation is quarantined under
  // logs/invalid-tasks/ instead of being committed to the build queue.
  const newFiles = [];
  const invalidTasks = [];
  for (const name of createdFiles) {
    const check = validateTaskFile(fs.readFileSync(path.join(PENDING_DIR, name), "utf8"));
    if (check.ok) {
      newFiles.push(name);
      continue;
    }
    const quarantine = path.join(LOGS_DIR, "invalid-tasks");
    fs.mkdirSync(quarantine, { recursive: true });
    fs.renameSync(path.join(PENDING_DIR, name), path.join(quarantine, name));
    invalidTasks.push({ file: name, errors: check.errors });
    log_(`run-ideation: quarantined invalid task ${name}`, { errors: check.errors });
  }

  const ideasProposed = newFiles.map((name) => {
    const { frontmatter, body } = readTaskFile(path.join(PENDING_DIR, name));
    return {
      file: name,
      title: frontmatter.title ?? name,
      source: frontmatter.source ?? "gatsby",
      created: frontmatter.created,
      rationale: body.slice(0, 300),
    };
  });

  const logEntry = {
    timestamp: new Date().toISOString(),
    outcome: ideasProposed.length > 0 ? "proposed" : "no_ideas",
    ideasProposed,
    invalidTasks,
    contextGiven: { doneCount: done.length, rejectedCount: rejected.length },
    claude: {
      isError: result.is_error ?? false,
      numTurns: result.num_turns,
      durationMs: result.duration_ms,
      totalCostUsd: result.total_cost_usd,
      usage: result.usage,
      resultText: result.result,
    },
  };

  if (ideasProposed.length === 0) {
    log_("run-ideation: no ideas proposed this run.");
    writeLog(logEntry);
    return;
  }

  log_(`run-ideation: proposed ${ideasProposed.length} idea(s): ${newFiles.join(", ")}`);

  try {
    execFileSync("git", ["add", "-A", "--", "tasks/pending"], { cwd: ROOT });
    execFileSync(
      "git",
      [
        "commit",
        "-m",
        `Propose ${ideasProposed.length} task(s) from ideation run\n\n${newFiles.join("\n")}`,
      ],
      { cwd: ROOT },
    );
    log_("Committed proposed task(s).");
  } catch (err) {
    log_("run-ideation: git commit of proposed task(s) failed", {
      error: err?.message ?? String(err),
    });
    logEntry.gitCommitError = err?.message ?? String(err);
  }

  writeLog(logEntry);
}

main();
