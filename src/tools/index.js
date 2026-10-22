// Tool schemas + dispatcher for deep_thoughtful mode's custom (non-Anthropic-
// hosted) tools. Unlike WEB_SEARCH_TOOL — an Anthropic-hosted tool Anthropic
// executes server-side with no round trip back to this code — a call to any
// of these is actually executed here, against a real API, by
// executeCustomTool below.

import { log } from "../logger.js";
import { githubReadFile, githubWriteFile, githubListRepos, githubListCommits } from "./github.js";
import { gmailSearch, gmailReadMessage, gmailMarkRead } from "./gmail.js";
import { calendarListEvents, calendarCreateEvent } from "./calendar.js";
import { listLocalDirectory, readLocalFile } from "./localFiles.js";
import { appendMemoryFact } from "../longTermMemory.js";
import { isSelfImproveApproved } from "../config.js";
import { queueTask } from "../taskQueue.js";
import { isRobotConnected, sendRobotCommand } from "../robotLink.js";
import { createDelegatedTask, listTasks, getTaskResult } from "../delegatedTasks.js";

// Drives the physical desk robot. Only offered while the robot is connected, and never while
// reacting to a robot report (ws.robotAnnouncing), so a report can't trigger another search.
export const ROBOT_FIND_ME_TOOL = {
  name: "robot_find_me",
  description:
    "Make your robot body (the small wheeled robot with a camera on the owner's desk that you speak through) physically look for the owner: it turns in place scanning for a face, drives up to the person it sees, and checks whether the face matches the owner's enrolled face. Use it when he asks you to find him, come to him, or look for him. It starts after your reply has finished playing and takes up to about half a minute; the outcome is reported back to you automatically afterwards, so in this reply just say you're on your way and do not guess the result.",
  input_schema: { type: "object", properties: {} },
};

export const GITHUB_READ_TOOL = {
  name: "github_read_file",
  description:
    "Read a file's content from a GitHub repository on the account (any repo, not just this one), as of the last commit actually pushed there. For THIS repo specifically, that can be stale: files this server writes to at runtime (personalities/*/memory.json, tasks/*) are not automatically committed back to GitHub, so this tool can show an outdated snapshot of your own memory or task state. To check what's actually true right now on this server — your real current long-term memory, in particular — use local_read_file instead. Returns the decoded text content and the file's sha — the sha is needed if you follow up with github_propose_write to update this same file.",
  input_schema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or org login)." },
      repo: { type: "string", description: "Repository name." },
      path: { type: "string", description: "File path within the repo." },
    },
    required: ["owner", "repo", "path"],
  },
};

// Does NOT touch GitHub. Only ever records a proposal on the connection
// (ws.pendingGithubWrite) and tells the model to relay it and ask for
// confirmation. Which write tool is even offered (this one vs.
// GITHUB_CONFIRM_TOOL) is decided per-round by getCustomTools below, based
// on connection state — not a behavioral instruction the model could ignore
// under pressure, a structural fact about what's callable at all. See
// executeCustomTool and the expiry logic in speechPipeline.js.
export const GITHUB_PROPOSE_TOOL = {
  name: "github_propose_write",
  description:
    "Propose creating or updating a file in a GitHub repository on the account (any repo, not just this one). This does NOT make the change — it only records the proposal. Describe the exact change to the person in your reply and ask them to explicitly confirm before anything is written; only after they say yes does github_confirm_write (offered starting next turn) become available to actually execute it. Pass sha (from a prior github_read_file call on this same path) when proposing to update an existing file; omit sha when proposing a brand-new file.",
  input_schema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      path: { type: "string" },
      content: { type: "string", description: "The full new file content (not a diff)." },
      message: { type: "string", description: "Commit message to use if confirmed." },
      sha: {
        type: "string",
        description: "Blob sha of the file being replaced; omit when proposing a new file.",
      },
    },
    required: ["owner", "repo", "path", "content", "message"],
  },
};

// Takes no file-content parameters, by design: it can only ever execute
// whatever is already sitting in ws.pendingGithubWrite, so there is no path
// for the model to describe one change and silently execute a different
// one. Only offered at all once a proposal exists.
export const GITHUB_CONFIRM_TOOL = {
  name: "github_confirm_write",
  description:
    "Execute the single pending GitHub write proposal, exactly as already described to the person, now that they've explicitly confirmed it (said yes / go ahead / do it in response to your description of it). Takes no parameters. Only call this after an explicit confirmation for THIS proposal — if they didn't confirm, or asked for something different, don't call it.",
  input_schema: { type: "object", properties: {} },
};

export const GITHUB_LIST_REPOS_TOOL = {
  name: "github_list_repos",
  description:
    'List repositories accessible to the GitHub account, so you can answer things like "which of my repos..." or resolve a repo\'s exact owner/name without being told it explicitly.',
  input_schema: { type: "object", properties: {} },
};

// Complements GITHUB_READ_TOOL: that one needs an exact known file path,
// this one answers "what changed" questions — "what happened last night",
// "what got pushed to PaperBrawler this week" — for any repo on the
// account, without knowing a path up front. Read-only, same GITHUB_PAT
// credential/scope as every other GitHub tool.
export const GITHUB_LIST_COMMITS_TOOL = {
  name: "github_list_commits",
  description:
    'List recent commits on a GitHub repository on the account (any repo, not just this one) — each with its message, author, date, and files touched. Use this to answer things like "what changed last night" or "what got pushed to <repo> this week". Defaults to the last 24 hours if `since` is omitted, and to a handful of the most recent commits if `limit` is omitted. If the result has more than a couple of commits, summarize it conversationally in your own words (group related changes, call out anything notable) rather than reading the raw list of commit messages verbatim.',
  input_schema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or org login)." },
      repo: { type: "string", description: "Repository name." },
      since: {
        type: "string",
        description: "ISO 8601 timestamp; only commits after this are returned. Omit for the last 24 hours.",
      },
      limit: {
        type: "number",
        description: "Max number of commits to return (most recent first). Omit for a small default; capped regardless.",
      },
    },
    required: ["owner", "repo"],
  },
};

// Local to this server's own working tree, not the GitHub API — see
// localFiles.js. Answers "what's in tasks/pending" etc. without a round
// trip to GitHub and without needing github_read_file's exact-filename
// limitation worked around.
export const LOCAL_LIST_DIRECTORY_TOOL = {
  name: "local_list_directory",
  description:
    'List the files and subdirectories in a directory of this bot\'s own repo, as it actually sits on disk on this server right now (including anything not yet committed or pushed). Use this to answer things like "what\'s in the pending task queue" or "what files are in tasks/done". Returns each entry\'s name, type (file/dir), and path — not file content, see local_read_file for that. Read-only, and confined to this repo — cannot list anything outside it.',
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          'Directory path relative to the repo root, e.g. "tasks/pending" or "tasks/done". Omit or pass "." for the repo root.',
      },
    },
  },
};

// Counterpart to LOCAL_LIST_DIRECTORY_TOOL for actual file content. Exists
// specifically so checking your own current state (long-term memory, a
// task file) doesn't have to go through github_read_file, which can be
// stale for exactly those files — see its description.
export const LOCAL_READ_FILE_TOOL = {
  name: "local_read_file",
  description:
    'Read a file\'s exact content as it actually sits on disk on this server right now, including anything not yet committed or pushed to GitHub. This is the authoritative way to check your own current state — e.g. your real long-term memory at "personalities/<your-personality-folder>/memory.json", or a task file under tasks/. Read-only, confined to this repo, refuses hidden/sensitive paths (.env, .git, node_modules).',
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'File path relative to the repo root, e.g. "personalities/gatsby-sardonic/memory.json".',
      },
    },
    required: ["path"],
  },
};

export const GMAIL_SEARCH_TOOL = {
  name: "gmail_search",
  description:
    "Search Gmail using Gmail's own search syntax (from:, subject:, is:unread, newer_than:7d, etc.). Returns { results, resultSizeEstimate, truncated } where results is a list of {id, snippet, subject, from, date}, capped at 10 — read-only, does not mark anything as read. If truncated is true, more messages matched than are shown; say \"at least N\" (using resultSizeEstimate) rather than implying the list is exhaustive.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A Gmail search query." },
    },
    required: ["query"],
  },
};

export const GMAIL_READ_TOOL = {
  name: "gmail_read_message",
  description: "Read the full body of one Gmail message by id. Read-only, does not mark it as read.",
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
    },
    required: ["message_id"],
  },
};

export const GMAIL_MARK_READ_TOOL = {
  name: "gmail_mark_read",
  description:
    "Mark one Gmail message as read by removing its UNREAD label. The only Gmail write action available — there is no send, delete, or other label-change tool.",
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
    },
    required: ["message_id"],
  },
};

export const CALENDAR_LIST_TOOL = {
  name: "calendar_list_events",
  description:
    "List Google Calendar events on the primary calendar within a time range. Capped at a small number of events per call regardless of maxResults; if the result comes back truncated, ask for a narrower time range rather than assuming the list is exhaustive.",
  input_schema: {
    type: "object",
    properties: {
      time_min: {
        type: "string",
        description:
          "RFC3339 timestamp, start of range. Write it as the person's local wall-clock time with no UTC offset (e.g. \"2026-10-14T09:00:00\") — the server attaches the correct time zone for you, so do not calculate or embed a UTC offset yourself.",
      },
      time_max: {
        type: "string",
        description: "RFC3339 timestamp, end of range. Same local wall-clock convention as time_min.",
      },
      maxResults: {
        type: "number",
        description: "Max number of events to return (soonest first). Omit for a small default; capped regardless.",
      },
    },
    required: ["time_min", "time_max"],
  },
};

// Stays a plain prompt-level instruction rather than a propose/confirm pair
// like GitHub writes — creating a calendar event is reversible and
// low-stakes compared to a repo write, so the lighter gate here is a
// deliberate difference in treatment, not an oversight.
export const CALENDAR_CREATE_TOOL = {
  name: "calendar_create_event",
  description:
    "Create an event on the primary Google Calendar. Only call this when the person has explicitly asked you to add, schedule, or create a calendar event in this turn. Never call this proactively, speculatively, or because something merely sounds like it belongs on a calendar.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      start: {
        type: "string",
        description:
          "RFC3339 timestamp, event start. Write it as the person's local wall-clock time with no UTC offset (e.g. \"2026-10-14T14:00:00\") — the server attaches the correct time zone for you, so do not calculate or embed a UTC offset yourself.",
      },
      end: {
        type: "string",
        description: "RFC3339 timestamp, event end. Same local wall-clock convention as start.",
      },
      description: { type: "string" },
    },
    required: ["summary", "start", "end"],
  },
};

// Only offered on a turn speechPipeline.js has already classified as an
// explicit "remember this"-style request (isMemoryTrigger) — not on every
// turn — so the model never has standing invitation to save things
// speculatively. Writing is deliberately single-step, unlike the GitHub
// propose/confirm pair: a memory write is low-stakes and easily inspected
// (memory.json) or deleted by hand, so it doesn't need the same gate.
export const SAVE_MEMORY_TOOL = {
  name: "save_memory",
  description:
    "Persist a fact to your own long-term memory (survives restarts, gets loaded into every future conversation). Only offered when the person has explicitly asked you to remember/save/keep something in mind — call it now, in this turn, before you reply. Decide for yourself what's actually worth keeping from the conversation and write it in your own words as ONE concise factual sentence (aim for 20 words or fewer) — not a transcript dump. Choose 1-3 short lowercase tags categorizing it. Call this more than once in the same turn if there are several genuinely distinct facts worth keeping separately, rather than cramming them into one fact.",
  input_schema: {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: "A single concise factual sentence to remember, in your own words.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "1-3 short lowercase tags categorizing this fact.",
      },
    },
    required: ["fact"],
  },
};

// Adds a task to tasks/pending/ (the nightly build queue) on the person's
// explicit say-so. Single-step, unlike the GitHub propose/confirm pair: the
// request itself is the confirmation, the file is easily removed
// (`npm run reject-task`), and nothing outside this checkout is touched.
// Only offered to personalities in config.json's self_improve_personalities
// (see getCustomTools / runCustomTool) — an ideas-of-your-own path
// (propose_task in deepThoughtful.js) is separate and unaffected.
export const QUEUE_TASK_TOOL = {
  name: "queue_task",
  description:
    "Add a task to this bot's own build queue (tasks/pending/, built overnight by the nightly job) when the person explicitly asks you to add, queue, or put something on the build queue. Call it in this turn — it writes and commits the task file immediately, so there is no separate confirmation step. Put everything the person specified (requirements, constraints, acceptance criteria) into description, written for the engineer who will build it, without inventing scope. Use this — NOT github_propose_write — for this bot's own task queue. Do not call it unless they explicitly asked. If the task would change your personality or voice, include the person's exact words asking for it in double quotes in description, and ask for a small change; without a genuine quote the build is rejected.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the task." },
      description: {
        type: "string",
        description: "What to build or fix and why, faithful to what the person asked for.",
      },
    },
    required: ["title", "description"],
  },
};

// friendly-mode-only (see FRIENDLY_ONLY_TOOL_NAMES and getCustomTools below)
// — a substantial request (summarize unread emails, add a calendar event,
// research something) gets handed to a background `claude -p` worker
// instead of run live. Returns immediately; the work happens out of band
// and is reported back via list_tasks/get_task_result, never spoken
// unprompted — see CAPABILITIES.md's "Async task delegation" section.
export const DELEGATE_TASK_TOOL = {
  name: "delegate_task",
  description:
    "Hand a substantial request off to a background worker instead of answering it live — use this for things that would take a while or need real tool access (e.g. \"summarize my unread emails\", \"add this to my calendar and also look up directions\", \"research X and tell me about it later\"), NOT for quick questions or banter. Returns immediately with a task_id; the work runs in the background and is never spoken aloud on completion — the person will ask what's finished later (list_tasks) and ask to hear a specific one (get_task_result). After calling this, just give a brief one-line in-character acknowledgment that you're on it — do not describe the work in detail or guess the outcome.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short title, spoken aloud later when listing finished tasks." },
      request: {
        type: "string",
        description: "The full instruction for the worker, faithful to what the person actually asked for.",
      },
    },
    required: ["title", "request"],
  },
};

export const LIST_TASKS_TOOL = {
  name: "list_tasks",
  description:
    "List delegated background tasks as [{id, title, status}] (status is running, done, failed, or needs_confirmation) — use this to answer \"what's finished\"/\"anything done yet\" questions, and to resolve which task the person means by name (e.g. \"the emails one\") before calling get_task_result. Defaults to only tasks not yet heard (include_heard to also see ones already reported). If two titles are ambiguously close to what the person said, ask which one they mean rather than guessing.",
  input_schema: {
    type: "object",
    properties: {
      include_heard: {
        type: "boolean",
        description: "Include tasks already reported via get_task_result. Defaults to false (unheard only).",
      },
    },
  },
};

export const GET_TASK_RESULT_TOOL = {
  name: "get_task_result",
  description:
    "Get the spoken-length summary of one delegated task by id (from list_tasks) — returns {title, status, summary} and marks it as heard. Never returns the full result, only the short summary meant to be spoken aloud. Use list_tasks first to find the right id when the person refers to a task by name.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
    },
    required: ["task_id"],
  },
};

// Tool availability is connection-state-dependent, not just mode-dependent:
// github_confirm_write is only ever offered once a proposal actually
// exists — there is nothing to confirm otherwise, so the execute tool isn't
// on the table at all. Called fresh every round (see speechPipeline.js),
// since a propose call earlier in the SAME turn's tool loop can flip which
// tool is offered on the very next round. memoryTriggered follows the same
// per-round-recompute pattern, though it's actually constant for the whole
// turn (see runTextPipeline) — passed in rather than detected here since
// the classification (isMemoryTrigger) already happened once upstream.
// effectiveMode gates delegate_task/list_tasks/get_task_result to friendly
// only — sentry_intruder and bump_complaint must never see them, and
// deep_thoughtful (which gets every other tool here) deliberately doesn't
// either: async delegation is a friendly-mode-only feature per
// CAPABILITIES.md, not a general tool-enabled-mode one.
export function getCustomTools(ws, { memoryTriggered = false, effectiveMode } = {}) {
  return [
    GITHUB_READ_TOOL,
    ws.pendingGithubWrite ? GITHUB_CONFIRM_TOOL : GITHUB_PROPOSE_TOOL,
    GITHUB_LIST_REPOS_TOOL,
    GITHUB_LIST_COMMITS_TOOL,
    LOCAL_LIST_DIRECTORY_TOOL,
    LOCAL_READ_FILE_TOOL,
    GMAIL_SEARCH_TOOL,
    GMAIL_READ_TOOL,
    GMAIL_MARK_READ_TOOL,
    CALENDAR_LIST_TOOL,
    CALENDAR_CREATE_TOOL,
    ...(memoryTriggered ? [SAVE_MEMORY_TOOL] : []),
    ...(isSelfImproveApproved(ws.lastKnownPersonality) ? [QUEUE_TASK_TOOL] : []),
    ...(isRobotConnected() && !ws.robotAnnouncing ? [ROBOT_FIND_ME_TOOL] : []),
    ...(effectiveMode === "friendly" ? [DELEGATE_TASK_TOOL, LIST_TASKS_TOOL, GET_TASK_RESULT_TOOL] : []),
  ];
}

// Every custom tool name that could ever appear in a tool_use block, across
// both states of the GitHub write gate — used only to distinguish "the
// model wants to call one of ours" from web_search_tool_result blocks
// (which never carry stop_reason: "tool_use" back to us and need no
// handling here). Doesn't need to match what a given round actually offered;
// a tool_use block's name is always one this session offered at some point.
export const CUSTOM_TOOL_NAMES = new Set([
  GITHUB_READ_TOOL.name,
  GITHUB_PROPOSE_TOOL.name,
  GITHUB_CONFIRM_TOOL.name,
  GITHUB_LIST_REPOS_TOOL.name,
  GITHUB_LIST_COMMITS_TOOL.name,
  LOCAL_LIST_DIRECTORY_TOOL.name,
  LOCAL_READ_FILE_TOOL.name,
  GMAIL_SEARCH_TOOL.name,
  GMAIL_READ_TOOL.name,
  GMAIL_MARK_READ_TOOL.name,
  CALENDAR_LIST_TOOL.name,
  CALENDAR_CREATE_TOOL.name,
  SAVE_MEMORY_TOOL.name,
  QUEUE_TASK_TOOL.name,
  ROBOT_FIND_ME_TOOL.name,
  DELEGATE_TASK_TOOL.name,
  LIST_TASKS_TOOL.name,
  GET_TASK_RESULT_TOOL.name,
]);

// Names routed through runCustomTool's HANDLERS table whose input needs
// ws.timezone attached before the handler runs — see runCustomTool below.
const CALENDAR_TOOL_NAMES = new Set([CALENDAR_LIST_TOOL.name, CALENDAR_CREATE_TOOL.name]);

const HANDLERS = {
  github_read_file: githubReadFile,
  github_list_repos: githubListRepos,
  github_list_commits: githubListCommits,
  local_list_directory: listLocalDirectory,
  local_read_file: readLocalFile,
  gmail_search: gmailSearch,
  gmail_read_message: gmailReadMessage,
  gmail_mark_read: gmailMarkRead,
  calendar_list_events: calendarListEvents,
  calendar_create_event: calendarCreateEvent,
};

// Logged instead of the raw input for tools whose input could be large
// (github_propose_write's file content) or is otherwise not worth
// persisting to the generic per-call log verbatim — everything else logs
// as-is, it's already small. (github_propose_write's own dedicated log line
// below, unlike this one, does include full content — see executeCustomTool.)
function loggableInput(name, input) {
  if (name === "github_propose_write") {
    return {
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      message: input.message,
      hasSha: !!input.sha,
      contentLength: input.content?.length ?? 0,
    };
  }
  return input;
}

// Provider-agnostic dispatch: takes a bare tool name + input (no Anthropic
// tool_use block shape), returns a plain { text, isError } result. This is
// the single source of truth for what each tool actually does — both the
// Anthropic-SDK path (executeCustomTool below, used by friendly and
// deep_thoughtful/api) and the Agent SDK bridge (src/tools/agentSdkBridge.js,
// used by deep_thoughtful/claude-code) call this same function, so behavior
// (including the GitHub propose/confirm state on ws.pendingGithubWrite) is
// identical regardless of which model executes the surrounding loop.
//
// Never throws: a failed API call (bad path, 404, auth error, missing
// credentials, etc.) comes back as { isError: true, text: "Error: ..." } so
// the model sees the failure and can react to it in character — same
// convention as any other tool-use error handling, not an exception that
// kills the whole turn. activePersonality is only used by save_memory (which
// personality's memory.json to append to) — every other handler ignores it.
export async function runCustomTool(ws, name, input, activePersonality, effectiveMode) {
  log("deep_thoughtful: custom tool call", { name, input: loggableInput(name, input ?? {}) });
  try {
    if (name === "delegate_task" || name === "list_tasks" || name === "get_task_result") {
      // Re-checked here, not just when building the tool list: a tool name
      // can arrive from any model turn, and these three must never actually
      // run outside friendly mode, no matter what the round offered.
      if (effectiveMode !== "friendly") {
        throw new Error(`${name} is not available outside friendly mode`);
      }
    }

    if (name === "delegate_task") {
      const { title, request } = input ?? {};
      const { id } = createDelegatedTask({ title, request });
      log("friendly: task delegated via tool", { id, title });
      return { text: JSON.stringify({ task_id: id }), isError: false };
    }

    if (name === "list_tasks") {
      const { include_heard } = input ?? {};
      return { text: JSON.stringify(listTasks({ includeHeard: Boolean(include_heard) })), isError: false };
    }

    if (name === "get_task_result") {
      const { task_id } = input ?? {};
      const result = getTaskResult(task_id);
      if (!result) throw new Error(`No such task: ${task_id}`);
      return { text: JSON.stringify(result), isError: false };
    }

    if (name === "github_propose_write") {
      const { owner, repo, path, content, message, sha } = input ?? {};
      ws.pendingGithubWrite = { owner, repo, path, content, message, sha };
      // Full diff-relevant detail (including content), unlike the generic
      // log line above — this is the audit trail that makes an eventual
      // write traceable back to exactly what was proposed.
      log("deep_thoughtful: github write proposed", { owner, repo, path, message, sha: sha ?? null, content });
      return {
        text: "Proposal recorded, not yet written. Describe this exact change to the person and explicitly ask them to confirm before anything is written. Do not call github_confirm_write in this same turn — wait for their answer on a later turn.",
        isError: false,
      };
    }

    if (name === "github_confirm_write") {
      const pending = ws.pendingGithubWrite;
      // Single-shot: this attempt consumes the proposal regardless of
      // whether the write below actually succeeds.
      ws.pendingGithubWrite = null;
      if (!pending) {
        throw new Error("No pending GitHub write proposal to confirm.");
      }
      const result = await githubWriteFile(pending);
      log("deep_thoughtful: github write confirmed", {
        owner: pending.owner,
        repo: pending.repo,
        path: pending.path,
        sha: result.sha,
        commitUrl: result.commitUrl,
      });
      return { text: JSON.stringify(result), isError: false };
    }

    if (name === "robot_find_me") {
      const id = sendRobotCommand("summon");
      if (!id) throw new Error("The desk robot body is not connected right now.");
      return {
        text: "Search started. The robot begins once your reply has finished playing: it turns in place looking for a face, drives to the person, and checks whether it's the owner. The outcome will be reported to you separately, so say you're on your way and don't guess the result.",
        isError: false,
      };
    }

    if (name === "save_memory") {
      const { fact, tags } = input ?? {};
      if (typeof fact !== "string" || !fact.trim()) {
        throw new Error("fact is required and must be a non-empty string");
      }
      const cleanTags = Array.isArray(tags)
        ? tags
            .filter((t) => typeof t === "string" && t.trim())
            .map((t) => t.trim().toLowerCase())
            .slice(0, 3)
        : [];
      const saved = appendMemoryFact(activePersonality, fact.trim(), cleanTags);
      log("long-term memory: fact saved via tool", {
        activePersonality,
        fact: saved.fact,
        tags: saved.tags,
      });
      return { text: `Saved: "${saved.fact}"`, isError: false };
    }

    if (name === "queue_task") {
      // Re-checked here, not just when building the tool list: the tool name
      // can arrive from any model turn, and an unapproved personality must
      // never be able to write to the queue.
      if (!isSelfImproveApproved(activePersonality)) {
        throw new Error("queue_task is not available to this personality");
      }
      const { title, description } = input ?? {};
      const { filename, committed } = queueTask(process.cwd(), { title, description });
      const isCommitted = await committed;
      log("deep_thoughtful: task queued via tool", { filename, title, committed: isCommitted });
      return {
        text: `Queued as ${filename} in tasks/pending/${isCommitted ? "" : " (file written, but the git commit failed — the nightly build won't see it until it is committed)"}. Tell the person it's queued for the next nightly build.`,
        isError: false,
      };
    }

    // Own keys only: a model-supplied name like "constructor" must not resolve to an inherited function.
    const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    // Calendar calls get the connection's resolved IANA zone (ws.timezone,
    // set via resolveTimezone — see clientTime.js) attached here, at the
    // single dispatch chokepoint both the Anthropic-SDK and Agent-SDK tool
    // paths go through, rather than trusting the model to compute and embed
    // a correct UTC offset into start/end itself.
    const handlerInput = CALENDAR_TOOL_NAMES.has(name)
      ? { ...(input ?? {}), timeZone: ws.timezone }
      : (input ?? {});
    const result = await handler(handlerInput);
    return { text: JSON.stringify(result), isError: false };
  } catch (err) {
    const message = err?.message ?? String(err);
    log("deep_thoughtful: custom tool call failed", { name, error: message });
    return { text: `Error: ${message}`, isError: true };
  }
}

// Thin Anthropic-SDK-shape adapter over runCustomTool above — used by
// speechPipeline.js's anthropic.messages.create() tool loop (friendly and
// deep_thoughtful/api). block is an Anthropic tool_use content block
// ({type, id, name, input}).
export async function executeCustomTool(ws, block, activePersonality, effectiveMode) {
  const { text, isError } = await runCustomTool(ws, block.name, block.input, activePersonality, effectiveMode);
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: text,
    ...(isError ? { is_error: true } : {}),
  };
}
