// Agent SDK (Claude Code) equivalent of getCustomTools/executeCustomTool in
// ./index.js — used only by deep_thoughtful's DEEP_THOUGHTFUL_PROVIDER =
// "claude-code" path (see src/speechPipeline.js). Every tool here delegates
// to runCustomTool, the same provider-agnostic dispatch function the
// Anthropic-SDK path (friendly, deep_thoughtful/api) uses — so behavior,
// including the ws.pendingGithubWrite propose/confirm state, is identical
// regardless of which model executes the surrounding loop. Only the schema
// representation differs (zod shapes here vs. JSON-schema input_schema in
// ./index.js); description text is imported from there so the two never
// drift apart.
//
// Each tool's schema/description mirrors its ./index.js counterpart exactly
// — see that file for the reasoning behind each tool's shape and gating.

import { z } from "zod";
import { isSelfImproveApproved } from "../config.js";
import { isRobotConnected } from "../robotLink.js";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  runCustomTool,
  GITHUB_READ_TOOL,
  GITHUB_PROPOSE_TOOL,
  GITHUB_CONFIRM_TOOL,
  GITHUB_LIST_REPOS_TOOL,
  GITHUB_LIST_COMMITS_TOOL,
  LOCAL_LIST_DIRECTORY_TOOL,
  LOCAL_READ_FILE_TOOL,
  GMAIL_SEARCH_TOOL,
  GMAIL_READ_TOOL,
  GMAIL_MARK_READ_TOOL,
  CALENDAR_LIST_TOOL,
  CALENDAR_CREATE_TOOL,
  SAVE_MEMORY_TOOL,
  QUEUE_TASK_TOOL,
  ROBOT_FIND_ME_TOOL,
  DELEGATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  GET_TASK_RESULT_TOOL,
} from "./index.js";

// Wraps runCustomTool's plain { text, isError } result as the MCP
// CallToolResult shape the Agent SDK's tool() handler must return.
function toCallToolResult({ text, isError }) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

// name is passed explicitly (rather than read off the schema constant)
// because the shared dispatch in runCustomTool keys off it — this keeps the
// wiring below a flat, obviously-correct list rather than something clever.
// effectiveMode is threaded through to runCustomTool unchanged — it's what
// lets delegate_task/list_tasks/get_task_result re-check "friendly only" at
// dispatch time, same as the Anthropic-SDK path (see runCustomTool).
function bridgeTool(schema, zodShape, name, ws, activePersonality, effectiveMode) {
  return tool(name, schema.description, zodShape, async (args) =>
    toCallToolResult(await runCustomTool(ws, name, args, activePersonality, effectiveMode)),
  );
}

// Builds the full, always-available tool list (independent of
// ws.pendingGithubWrite / memoryTriggered — see createDeskmatesMcpServer).
function allBridgeTools(ws, activePersonality, effectiveMode) {
  return {
    github_read_file: bridgeTool(
      GITHUB_READ_TOOL,
      { owner: z.string(), repo: z.string(), path: z.string() },
      "github_read_file",
      ws,
      activePersonality,
      effectiveMode,
    ),
    github_propose_write: bridgeTool(
      GITHUB_PROPOSE_TOOL,
      {
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        content: z.string(),
        message: z.string(),
        sha: z.string().optional(),
      },
      "github_propose_write",
      ws,
      activePersonality,
      effectiveMode,
    ),
    github_confirm_write: bridgeTool(
      GITHUB_CONFIRM_TOOL,
      {},
      "github_confirm_write",
      ws,
      activePersonality,
      effectiveMode,
    ),
    github_list_repos: bridgeTool(
      GITHUB_LIST_REPOS_TOOL,
      {},
      "github_list_repos",
      ws,
      activePersonality,
      effectiveMode,
    ),
    github_list_commits: bridgeTool(
      GITHUB_LIST_COMMITS_TOOL,
      { owner: z.string(), repo: z.string(), since: z.string().optional(), limit: z.number().optional() },
      "github_list_commits",
      ws,
      activePersonality,
      effectiveMode,
    ),
    local_list_directory: bridgeTool(
      LOCAL_LIST_DIRECTORY_TOOL,
      { path: z.string().optional() },
      "local_list_directory",
      ws,
      activePersonality,
      effectiveMode,
    ),
    local_read_file: bridgeTool(
      LOCAL_READ_FILE_TOOL,
      { path: z.string() },
      "local_read_file",
      ws,
      activePersonality,
      effectiveMode,
    ),
    gmail_search: bridgeTool(
      GMAIL_SEARCH_TOOL,
      { query: z.string() },
      "gmail_search",
      ws,
      activePersonality,
      effectiveMode,
    ),
    gmail_read_message: bridgeTool(
      GMAIL_READ_TOOL,
      { message_id: z.string() },
      "gmail_read_message",
      ws,
      activePersonality,
      effectiveMode,
    ),
    gmail_mark_read: bridgeTool(
      GMAIL_MARK_READ_TOOL,
      { message_id: z.string() },
      "gmail_mark_read",
      ws,
      activePersonality,
      effectiveMode,
    ),
    calendar_list_events: bridgeTool(
      CALENDAR_LIST_TOOL,
      { time_min: z.string(), time_max: z.string(), maxResults: z.number().optional() },
      "calendar_list_events",
      ws,
      activePersonality,
      effectiveMode,
    ),
    calendar_create_event: bridgeTool(
      CALENDAR_CREATE_TOOL,
      { summary: z.string(), start: z.string(), end: z.string(), description: z.string().optional() },
      "calendar_create_event",
      ws,
      activePersonality,
      effectiveMode,
    ),
    save_memory: bridgeTool(
      SAVE_MEMORY_TOOL,
      { fact: z.string(), tags: z.array(z.string()).optional() },
      "save_memory",
      ws,
      activePersonality,
      effectiveMode,
    ),
    queue_task: bridgeTool(
      QUEUE_TASK_TOOL,
      { title: z.string(), description: z.string() },
      "queue_task",
      ws,
      activePersonality,
      effectiveMode,
    ),
    robot_find_me: bridgeTool(ROBOT_FIND_ME_TOOL, {}, "robot_find_me", ws, activePersonality, effectiveMode),
    delegate_task: bridgeTool(
      DELEGATE_TASK_TOOL,
      { title: z.string(), request: z.string() },
      "delegate_task",
      ws,
      activePersonality,
      effectiveMode,
    ),
    list_tasks: bridgeTool(
      LIST_TASKS_TOOL,
      { include_heard: z.boolean().optional() },
      "list_tasks",
      ws,
      activePersonality,
      effectiveMode,
    ),
    get_task_result: bridgeTool(
      GET_TASK_RESULT_TOOL,
      { task_id: z.string() },
      "get_task_result",
      ws,
      activePersonality,
      effectiveMode,
    ),
  };
}

// Mirrors getCustomTools(ws, {memoryTriggered, effectiveMode}) in ./index.js:
// github_confirm_write is only offered once a proposal exists,
// github_propose_write otherwise, never both; save_memory only when this
// turn was classified as a "remember this" request; robot_find_me only while
// the physical robot is connected and not itself mid-announcement
// (ws.robotAnnouncing); delegate_task/list_tasks/get_task_result only in
// friendly mode, same as the API path — same reasoning as there: async
// delegation is a friendly-mode-only feature, not a general tool-enabled-
// mode one. Built fresh per turn — not a module-level singleton — so it
// closes over that turn's own `ws` (connection-scoped state, matching
// ws.pendingGithubWrite's existing per-connection lifetime) rather than
// leaking one connection's pending write into another's.
export function createDeskmatesMcpServer(ws, activePersonality, { memoryTriggered = false, effectiveMode } = {}) {
  const all = allBridgeTools(ws, activePersonality, effectiveMode);
  const tools = [
    all.github_read_file,
    ws.pendingGithubWrite ? all.github_confirm_write : all.github_propose_write,
    all.github_list_repos,
    all.github_list_commits,
    all.local_list_directory,
    all.local_read_file,
    all.gmail_search,
    all.gmail_read_message,
    all.gmail_mark_read,
    all.calendar_list_events,
    all.calendar_create_event,
    ...(memoryTriggered ? [all.save_memory] : []),
    ...(isSelfImproveApproved(activePersonality) ? [all.queue_task] : []),
    ...(isRobotConnected() && !ws.robotAnnouncing ? [all.robot_find_me] : []),
    ...(effectiveMode === "friendly" ? [all.delegate_task, all.list_tasks, all.get_task_result] : []),
  ];
  return createSdkMcpServer({ name: "deskmates-tools", tools, alwaysLoad: true });
}
