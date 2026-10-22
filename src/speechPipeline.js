import "./httpAgent.js";
import { randomUUID } from "node:crypto";
import { logRateLimitEvent } from "./turnLog.js";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { chunkTextToSpeech } from "./ttsChunking.js";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { readConfig, isSelfImproveApproved, isClaudeCodeChatApproved, resolveLlm, LLM_CHOICES } from "./config.js";
import { loadActivePersonality, getCapabilitiesBlock, getApprovedInsightsBlock, resolveVoiceSpeed } from "./turnContext.js";
import { getCannedResponse } from "./cannedResponses.js";
import { appendTurn, getTurns, clearTurns, noteSearchedReply, getSearchedReplies } from "./sessionMemory.js";
import { isMemoryTrigger, getLongTermMemoryBlock, condenseAndStore } from "./longTermMemory.js";
import { listTaskFiles } from "./taskFile.js";
import { writeSelfAuthoredTask, GATSBY_CONVERSATION_SOURCE } from "./taskQueue.js";
import { getCustomTools, CUSTOM_TOOL_NAMES, executeCustomTool } from "./tools/index.js";
import { matchExplicitDelegate, createDelegatedTask, countUnheardTasks } from "./delegatedTasks.js";
import { createDeskmatesMcpServer } from "./tools/agentSdkBridge.js";
import { log } from "./logger.js";
import { noSpeechResult } from "./transcript.js";
import { retryMethods } from "./retry.js";
import { stripDeepThoughtfulPrefix, resolveEffectiveMode, parseDeepThoughtfulOutput, SELF_PROPOSAL_OUTPUT_FORMAT } from "./deepThoughtful.js";
import { withTimeTag, TIME_RULE } from "./clientTime.js";

const ROOT = process.cwd();
// Where getSelfProposalsBlock looks for source: gatsby-conversation task
// files — deliberately excludes tasks/proposed/, since the conversational
// path (writeSelfAuthoredTask below) writes straight to tasks/pending/ and
// a gatsby-conversation file could never land in tasks/proposed/.
const SELF_PROPOSAL_TASK_DIRS = ["pending", "done", "failed", "rejected"];

// Both clients read their API keys from ANTHROPIC_API_KEY / ELEVENLABS_API_KEY
// automatically; constructing them once and reusing them (rather than
// per-request) is what lets the keep-alive dispatcher above actually pool
// connections across requests.
//
// Transient failures (network hiccups, 5xx, 429) are retried 3x with
// exponential backoff inside these wrapped methods, so call sites are
// unchanged. TTS is wrapped before chunkTextToSpeech below, so each chunk is
// retried on its own.
const anthropic = retryMethods(new Anthropic(), ["messages.create"], "Claude call", log);
const elevenlabs = retryMethods(new ElevenLabsClient(), ["speechToText.convert", "textToSpeech.convert"], "ElevenLabs call", log);
// Every mode's reply goes through this same TTS call; chunking only kicks in
// when a (long, e.g. deep_thoughtful) reply exceeds the model's char cap.
chunkTextToSpeech(elevenlabs.textToSpeech);

const STT_MODEL = "scribe_v2";
const TTS_MODEL = "eleven_flash_v2_5";
// deep_thoughtful has no self-imposed length limit in the personality
// prompt (say what actually needs saying, unless the person asks for
// brevity) — this ceiling exists only as an API-level safety backstop
// against a genuinely runaway generation, not as the real constraint.
// It must stay comfortably above anything a normal thoughtful answer
// would need, or it silently truncates mid-sentence instead of the
// model choosing to stop.
const DEEP_THOUGHTFUL_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOKENS = 1024;

// friendly and deep_thoughtful get real tool access (web search, GitHub,
// Gmail, Calendar) — see TOOL_ENABLED_MODES below. sentry_intruder and
// bump_complaint deliberately don't: an unrecognized person shouldn't get
// live Gmail/GitHub access just by talking to the bot. This is separate
// from which mode gets the *deep_thoughtful response shape* (longer
// maxTokens, capabilities/insights/self-proposal context, the JSON
// propose_task output format) further down — friendly keeps ordinary
// short-line replies and Haiku speed even with tools attached; only an
// explicit deep_thoughtful trigger phrase gets the longer, more
// deliberated answer.
const TOOL_ENABLED_MODES = new Set(["friendly", "deep_thoughtful"]);

// This is a global, personality-agnostic gate (every character resolves
// through this same module), not a per-personality setting. Capped at 2
// uses to bound worst-case latency: search can run multiple rounds inside
// a single API call with no hard timeout, and the filler line's length is
// tuned to mask an ordinary Haiku round-trip, not an open-ended search
// chain.
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 2 };

// A search answer arrives split into pieces wherever a citation starts or
// ends. Mid-sentence pieces carry their own spacing, but a piece that starts
// a new sentence often doesn't: joined bare, that spoke as "days.Chicago"
// (2026-10-13). Adds a space only between a sentence end and a letter or
// quote, so "2." + "56" and ", and" joins are left alone.
export function joinTextBlocks(texts) {
  let out = "";
  for (const text of texts) {
    if (out && /[.!?]["”’')]?$/.test(out) && /^["“‘'(]?\p{L}/u.test(text)) out += " ";
    out += text;
  }
  return out.trim();
}

// Search answers: Haiku 5.5 tended to follow a sentence with a cited one
// restating it, which speaks as a repetition.
const SPOKEN_SEARCH_RULE =
  "WEB SEARCH ANSWERS: say each fact once. Never follow a sentence with another that restates it, even to attach a source.";

function searchedRepliesBlock(ws) {
  const replies = getSearchedReplies(ws);
  if (replies.length === 0) return "";
  return `YOUR EARLIER ANSWERS IN THIS CONVERSATION THAT CAME FROM A LIVE LOOKUP (web search, email, calendar or another tool; their facts were checked, so stand by them; never claim you didn't search):\n${replies.map((r) => `- "${r}"`).join("\n")}`;
}

// GitHub/Gmail/Calendar tools are genuinely different from WEB_SEARCH_TOOL:
// the model requests a call, our code actually executes it against a real
// API (see src/tools/index.js), and the result goes back to the model —
// which needs an actual agentic loop (below), not a single request/response.
// Bounds worst-case latency the same way web search's max_uses: 2 does.
const MAX_TOOL_ROUNDS = 4;

// Which model actually executes deep_thoughtful's tool loop — "api" (the
// historical default, billed against the Anthropic API key) or "claude-code"
// (routed through the Claude Agent SDK, billed against the operator's Claude
// Pro/Max/Team subscription instead). Read live (not cached at module load)
// so it can be flipped without a server restart, same as every other
// config.json-driven setting in this module. friendly mode is NOT gated by
// this var at all — see runViaAnthropicApi/TOOL_ENABLED_MODES below, it
// always uses the Anthropic API regardless of this value.
export function deepThoughtfulProvider() {
  return process.env.DEEP_THOUGHTFUL_PROVIDER === "claude-code" ? "claude-code" : "api";
}

// Whether a claude-code call that actually runs will be billed against the
// subscription (CLAUDE_CODE_OAUTH_TOKEN present) or silently fall through to
// ANTHROPIC_API_KEY the way claudeCodeAuthEnv() below does when that token
// is absent. This is the exact distinction the turn log's `provider` column
// needs — "claude-code" the code path ran is not the same fact as
// "claude-code" the billing was actually unmetered.
export function claudeCodeIsSubscriptionBilled() {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
}

// Opt-in only: with this unset/false (the default), a failure inside
// runViaClaudeCode() propagates as a turn error rather than silently
// retrying on the metered API — the caller asked for the subscription path
// specifically to avoid API spend, and a fallback that fires without being
// asked for defeats that. Set ALLOW_CLAUDE_CODE_API_FALLBACK=true to trade
// that guarantee for availability (a broken claude-code call still gets an
// answer, just billed against ANTHROPIC_API_KEY).
function allowClaudeCodeApiFallback() {
  return process.env.ALLOW_CLAUDE_CODE_API_FALLBACK === "true";
}

// Only meaningful once CLAUDE_CODE_OAUTH_TOKEN exists (manual `claude
// setup-token` step, see README) — until then this returns undefined and
// the Claude Code call inherits process.env as-is (ANTHROPIC_API_KEY and
// all), which still works for testing the mechanics, just billed against
// the API key like today. Once the OAuth token is present, ANTHROPIC_API_KEY
// is stripped from the child's env so it can't silently outrank the
// subscription token — this server's own key (needed by every
// anthropic.messages.create() call in this same process, unaffected by any
// of this) never leaks into the Claude Code subprocess's environment.
function claudeCodeAuthEnv() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// deep_thoughtful-only context: a title + status + one-line excerpt for
// every source: gatsby-conversation task file, across every stage it could
// be in. Lets the model answer "what have you proposed"/"did that thing
// you suggested happen" from real state, and dedupe a new idea against
// what it already suggested, without reading full task bodies or the rest
// of the tasks/ tree (human-written tasks, ideation's tasks/proposed/) on
// every deep_thoughtful turn.
function getSelfProposalsBlock() {
  const entries = SELF_PROPOSAL_TASK_DIRS.flatMap((status) =>
    listTaskFiles(path.join(ROOT, "tasks", status))
      .filter((t) => t.frontmatter.source === GATSBY_CONVERSATION_SOURCE)
      .map((t) => ({
        status,
        title: t.frontmatter.title ?? t.filename,
        excerpt: t.body.split("\n").find((l) => l.trim()) ?? "",
      })),
  );
  if (entries.length === 0) return "";

  const lines = entries.map((e) => `- [${e.status}] ${e.title} — ${e.excerpt}`).join("\n");
  return `YOUR PAST SELF-PROPOSALS (ideas you've suggested, in past conversations, for improving yourself — use this to answer questions about what you've proposed and to avoid suggesting the same thing twice):\n${lines}`;
}

// Small, cheap calls backing the explicit "delegate this"/"hand this off"
// path below — same spirit as longTermMemory.js's condenseAndStore (a tiny
// Haiku call to turn freeform text into one short string), kept local here
// since both are specific to the delegation short-circuit, not reusable
// elsewhere. `createMessage` is the same test seam runTextPipeline's main
// loop uses, threaded through so both are mockable in the same test.
async function deriveDelegateTitle(instruction, createMessage) {
  try {
    const response = await createMessage({
      model: LLM_CHOICES.haiku.model,
      max_tokens: 20,
      system:
        "You will be given an instruction for a background task. Output ONLY a short title for it, 6 words or fewer, no quotes, no trailing punctuation, nothing else.",
      messages: [{ role: "user", content: instruction }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const title = (textBlock?.text ?? "").trim().replace(/^["']+|["']+$/g, "");
    return title || instruction.split(/\s+/).slice(0, 8).join(" ");
  } catch (err) {
    log("friendly: delegate title derivation failed, falling back to a truncated instruction", {
      error: err?.message ?? String(err),
    });
    return instruction.split(/\s+/).slice(0, 8).join(" ");
  }
}

// Deliberately skips the model's judgment on WHETHER to delegate (that
// already happened — this phrase is explicit), asking it only for a short
// in-character acknowledgment. Falls back to a plain, not-in-character line
// on any failure rather than losing the ack entirely — the task itself was
// already created and started by the time this runs, so a failure here must
// never look like the delegation itself failed.
async function generateDelegateAck(systemPrompt, longTermBlock, title, createMessage) {
  const fullSystem = [systemPrompt, longTermBlock].filter(Boolean).join("\n\n");
  try {
    const response = await createMessage({
      model: LLM_CHOICES.haiku.model,
      max_tokens: 60,
      system: fullSystem,
      messages: [
        {
          role: "user",
          content: `[MODE: friendly] You just agreed to hand off some background work titled "${title}" to a worker. In ONE short spoken line, in character, acknowledge that you're on it — no questions, no description of the work, don't guess the outcome.`,
        },
      ],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const line = (textBlock?.text ?? "").trim();
    return { line: line || "On it.", usage: response.usage ?? {} };
  } catch (err) {
    log("friendly: delegate ack generation failed, using a fallback line", {
      error: err?.message ?? String(err),
    });
    return { line: "On it.", usage: {} };
  }
}

// A connection's session memory belongs to whatever personality was active
// when those turns were recorded. If active_personality has moved on since
// this connection's last request, those turns no longer describe a
// conversation the current personality actually had — wipe them, same as a
// brand-new connection would start empty. Checked lazily (on request),
// matching every other piece of config-driven state in this codebase —
// nothing here uses fs.watch, config.json is just re-read fresh each call.
function syncSessionMemoryToPersonality(ws, activePersonality) {
  if (
    ws.lastKnownPersonality !== undefined &&
    ws.lastKnownPersonality !== activePersonality
  ) {
    clearTurns(ws);
  }
  ws.lastKnownPersonality = activePersonality;
}

// The historical (and still default) path: anthropic.messages.create()
// directly, billed against ANTHROPIC_API_KEY. Used by friendly always, and by
// deep_thoughtful whenever DEEP_THOUGHTFUL_PROVIDER is not "claude-code". This
// is a straight extraction of the loop that used to live inline in
// runTextPipeline — no behavior change — so it could be parameterized and
// called from either branch below.
// Prompt caching (2026-10-19): every turn re-sent ~13.7k tokens of
// personality, memory, capabilities and tool definitions with zero cache hits.
// The stable part of the system prompt carries a cache breakpoint (which also
// covers the tools ahead of it); the per-turn part (unheard-task count, search
// notes) follows it uncached. A second breakpoint on the last message lets a
// tool round reuse the round before it. Never mutates the stored turns.
export function buildSystemBlocks(stableText, volatileText) {
  const blocks = [{ type: "text", text: stableText, cache_control: { type: "ephemeral" } }];
  if (volatileText) blocks.push({ type: "text", text: volatileText });
  return blocks;
}

// Tells the connection a tool is about to run (calendar, email, ...), so the
// bot can say something now instead of after its 4 s filler delay
// (2026-10-19). A failing listener never affects the turn.
export function notifyToolProgress(ws, toolNames) {
  if (typeof ws?.onTurnProgress !== "function") return;
  try {
    ws.onTurnProgress({ stage: "tool", tools: toolNames });
  } catch (err) {
    log("turn progress listener failed", { error: err?.message ?? String(err) });
  }
}

export function withMessageCacheBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const blocks =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.map((b) => ({ ...b }));
  if (blocks.length === 0) return messages;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

async function runViaAnthropicApi({
  ws,
  effectiveMode,
  fullSystemPrompt,
  systemBlocks,
  model,
  thinking,
  maxTokens,
  priorTurns,
  userTurnContent,
  activePersonality,
  memoryToolAvailable,
  // Seam so the model/thinking wiring is testable offline, same pattern as
  // runSpeechPipeline's `stt` param — defaults to the real metered call,
  // never mocked in place.
  createMessage = (params) => anthropic.messages.create(params),
}) {
  let messages = [...priorTurns, { role: "user", content: userTurnContent }];
  let llmResponse;
  // Names of custom (non-web-search) tools actually invoked this turn — only
  // ever populated in TOOL_ENABLED_MODES (friendly, deep_thoughtful — the
  // only modes any tool is offered in). Exposed on the result so callers
  // (and scripts/test-client.js) can assert on which tools fired for a turn,
  // not just infer it from reply text — needed in particular to verify
  // calendar_create_event is never called speculatively.
  const toolCallNames = [];
  let llmRounds = 0;
  let webSearches = 0;
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  // Whether github_confirm_write actually executed this turn — decides
  // whether a pending GitHub write proposal survives past this turn (see the
  // single-shot expiry check in runTextPipeline, right after this returns).
  let confirmWriteCalledThisTurn = false;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // getCustomTools(ws) is re-evaluated every round, not hoisted outside the
    // loop: which GitHub write tool it includes (propose vs. confirm)
    // depends on ws.pendingGithubWrite, and a propose call earlier in THIS
    // SAME turn's loop can flip that before the next round runs. On the
    // final round, tools are withheld entirely — otherwise a tool_use block
    // from this round would have no tool_result appended after it (the loop
    // is about to end), leaving the model's next reply built on a dangling
    // "let me check that" with no follow-through. Withholding tools forces a
    // real answer using whatever the model already knows.
    const roundTools =
      round < MAX_TOOL_ROUNDS && TOOL_ENABLED_MODES.has(effectiveMode)
        ? [WEB_SEARCH_TOOL, ...getCustomTools(ws, { memoryTriggered: memoryToolAvailable, effectiveMode })]
        : undefined;
    llmResponse = await createMessage({
      model,
      max_tokens: maxTokens,
      system: systemBlocks ?? fullSystemPrompt,
      ...(thinking ? { thinking } : {}),
      ...(roundTools ? { tools: roundTools } : {}),
      messages: withMessageCacheBreakpoint(messages),
    });
    // Accumulate rather than read once after the loop: llmResponse is
    // overwritten each round, so the final response's usage covers only the
    // last call. A tool-using turn is several calls, each resending the
    // conversation so far plus accumulated tool results — counting only the
    // last one would understate a tool turn's real cost, which is exactly
    // the comparison the turn log exists to make.
    llmRounds += 1;
    for (const key of Object.keys(usageTotals)) {
      usageTotals[key] += llmResponse.usage?.[key] ?? 0;
    }
    webSearches += llmResponse.usage?.server_tool_use?.web_search_requests ?? 0;
    const customToolUses = llmResponse.content.filter(
      (block) => block.type === "tool_use" && CUSTOM_TOOL_NAMES.has(block.name),
    );
    if (customToolUses.length === 0 || round === MAX_TOOL_ROUNDS) break;

    notifyToolProgress(ws, customToolUses.map((block) => block.name));
    toolCallNames.push(...customToolUses.map((block) => block.name));
    if (customToolUses.some((block) => block.name === "github_confirm_write")) {
      confirmWriteCalledThisTurn = true;
    }
    const toolResults = await Promise.all(
      customToolUses.map((block) => executeCustomTool(ws, block, activePersonality, effectiveMode)),
    );
    messages = [
      ...messages,
      { role: "assistant", content: llmResponse.content },
      { role: "user", content: toolResults },
    ];
  }
  // With web search and/or custom tools enabled, content can interleave
  // several block types across a round: an intent-narration text block
  // ("I'll search for..."), (server_)tool_use, a tool result, then the real
  // answer — itself possibly split across multiple text blocks wherever a
  // citation boundary falls. Taking just the first text block (the old
  // behavior) would speak the narration instead of the answer. Concatenating
  // every text block in the FINAL round's content, after the last
  // web_search_tool_result block, gets the actual final response regardless
  // of how many pieces it's split into, and behaves identically to the old
  // code when there's no tool use at all (nothing to skip past). Custom tool
  // rounds need no equivalent skip-past here: their tool_use/tool_result
  // pairs live in earlier, already-discarded `messages` entries, never in
  // this final response's own content.
  const lastToolResultIndex = llmResponse.content.reduce(
    (acc, block, i) => (block.type === "web_search_tool_result" ? i : acc),
    -1,
  );
  const rawText = joinTextBlocks(
    llmResponse.content.filter((block, i) => block.type === "text" && i > lastToolResultIndex).map((block) => block.text),
  );

  return { rawText, usageTotals, toolCallNames, llmRounds, webSearches, confirmWriteCalledThisTurn };
}

// The Claude Code path: the same tool loop, executed by the Claude Agent
// SDK instead — see src/tools/agentSdkBridge.js for the tool definitions
// (they delegate to the exact same runCustomTool dispatch
// runViaAnthropicApi's executeCustomTool wraps, so ws.pendingGithubWrite
// behaves identically either way). Reached for deep_thoughtful when
// DEEP_THOUGHTFUL_PROVIDER=claude-code, and for friendly when the active
// personality is listed in config.json's claude_code_chat_personalities —
// see the useClaudeCode gate in runTextPipeline. effectiveMode is passed
// through only so createDeskmatesMcpServer can decide whether
// delegate_task/list_tasks/get_task_result belong in this turn's tool list
// (friendly only, same as the API path) — it has no other effect here.
//
// Conversation history: query() takes a single prompt, not an Anthropic-
// style messages array, and its own resume/continue is disk-backed per
// working directory — the wrong shape for this connection-scoped, no-disk
// state. So prior turns are serialized into the prompt text itself (the
// same way long-term-memory/capabilities context is already serialized into
// fullSystemPrompt), and every turn is a fresh, stateless query() call
// (persistSession: false, no resume/continue).
//
// Tool-round withholding: query() has no documented "withhold tools on the
// last round" knob (maxTurns aborts the whole query with an error instead of
// forcing a final answer). canUseTool stands in for MAX_TOOL_ROUNDS instead:
// once customToolCalls reaches that many approvals, further custom-tool
// calls are denied with a message telling Claude to answer with what it has
// — same intent as withholding tools on the API path's final round, though a
// per-call budget rather than a strict per-round one (query() doesn't expose
// round boundaries), which if anything bounds cost/latency *more* tightly
// than today, never less. WebSearch gets its own budget, matching
// WEB_SEARCH_TOOL.max_uses.
async function runViaClaudeCode({
  ws,
  activePersonality,
  effectiveMode,
  fullSystemPrompt,
  priorTurns,
  userTurnContent,
  memoryToolAvailable,
  model,
}) {
  const server = createDeskmatesMcpServer(ws, activePersonality, { memoryTriggered: memoryToolAvailable, effectiveMode });

  const priorTurnsText = priorTurns
    .map((t) => `${t.role === "user" ? "Person" : "You"}: ${t.content}`)
    .join("\n\n");
  const prompt = priorTurnsText
    ? `CONVERSATION SO FAR:\n${priorTurnsText}\n\n${userTurnContent}`
    : userTurnContent;

  const toolCallNames = [];
  let confirmWriteCalledThisTurn = false;
  let customToolCalls = 0;
  let webSearchCalls = 0;
  const MCP_TOOL_PREFIX = "mcp__deskmates__";

  // Only ever invoked for tools actually offered (WebSearch via `tools`,
  // our 11 via `mcpServers`) — neither is in allowedTools, so every call
  // falls through to here rather than auto-approving (see the docs note
  // that allowedTools calls skip canUseTool entirely).
  const canUseTool = async (toolName) => {
    if (toolName === "WebSearch") {
      if (webSearchCalls >= WEB_SEARCH_TOOL.max_uses) {
        return {
          behavior: "deny",
          message: "Your web search budget for this turn is used up — answer now using what you already know.",
        };
      }
      webSearchCalls += 1;
      return { behavior: "allow" };
    }
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      if (customToolCalls >= MAX_TOOL_ROUNDS) {
        return {
          behavior: "deny",
          message:
            "You've used up your tool-call budget for this turn — answer now using what you already know, without calling any more tools.",
        };
      }
      customToolCalls += 1;
      return { behavior: "allow" };
    }
    // tools: ["WebSearch"] means nothing else should ever be offered — deny
    // defensively rather than silently allow something unaccounted for.
    return { behavior: "deny", message: `Tool ${toolName} is not available.` };
  };

  let rawText = "";
  let llmRounds = 0;
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  const authEnv = claudeCodeAuthEnv();
  // Groups this call's rate_limit_event messages in the turn log so the
  // call's own effect on the plan meters can be measured — see
  // usageSummary() in src/turnLog.js.
  const rateLimitCallId = randomUUID();
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: fullSystemPrompt,
      settingSources: [],
      tools: ["WebSearch"],
      mcpServers: { deskmates: server },
      canUseTool,
      permissionMode: "default",
      persistSession: false,
      model,
      ...(authEnv ? { env: authEnv } : {}),
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name.startsWith(MCP_TOOL_PREFIX)) {
          const bareName = block.name.slice(MCP_TOOL_PREFIX.length);
          toolCallNames.push(bareName);
          if (bareName === "github_confirm_write") confirmWriteCalledThisTurn = true;
        }
      }
    }
    if (message.type === "rate_limit_event") {
      // Plan utilization (five_hour / seven_day / ...) for the whole
      // claude.ai account, emitted whenever it changes. Fire-and-forget.
      logRateLimitEvent(message.rate_limit_info, rateLimitCallId);
    }
    if (message.type === "result") {
      llmRounds = message.num_turns ?? 0;
      for (const key of Object.keys(usageTotals)) {
        usageTotals[key] = message.usage?.[key] ?? 0;
      }
      if (message.subtype === "success") {
        rawText = message.result;
      }
    }
  }

  return {
    rawText,
    usageTotals,
    toolCallNames,
    llmRounds,
    webSearches: webSearchCalls,
    confirmWriteCalledThisTurn,
  };
}

// transcript: text already in hand — either STT output (speech_request) or
// a console's typed test string (text_request). Runs everything the two
// paths share: mode resolution, the memory-trigger canned-ack short-circuit,
// and the Claude call itself. Returns one of:
//   { kind: "text", transcript, effectiveMode, line }          — normal conversational turn
//   { kind: "canned", transcript, ok: true, lineId, bytes }    — memory-trigger ack
//   { kind: "canned", transcript, ok: false, reason }          — memory-trigger ack, no audio on disk yet
// Throws on failure of the Claude call — same contract as before, callers
// turn that into a *_error response.
export async function runTextPipeline(ws, mode, rawTranscript, timings, { createMessage } = {}) {
  const { activePersonality, systemPrompt } = loadActivePersonality();
  syncSessionMemoryToPersonality(ws, activePersonality);

  // A "dt:" prefix is consumed here, before anything else looks at the text:
  // everything downstream (trigger matching, the memory-trigger check, the
  // Claude request, session memory, the returned transcript) works with the
  // stripped version, so the marker never reaches the model or the log of
  // what was said.
  const { transcript, forced: forcedDeepThoughtful } =
    stripDeepThoughtfulPrefix(rawTranscript);

  // Explicit hand-off ("delegate this"/"hand this off" opening the
  // transcript, friendly only — never sentry_intruder/bump_complaint, and
  // deliberately not deep_thoughtful either, matching delegate_task's own
  // mode gate in src/tools/index.js) skips the model's judgment on WHETHER
  // to delegate — everything after the phrase becomes the task's request
  // outright. See CAPABILITIES.md's async task delegation section.
  //
  // Checked against the RAW `mode` and BEFORE resolveEffectiveMode, not
  // effectiveMode — a delegated instruction routinely contains a word that's
  // also a DEEP_THOUGHTFUL_TRIGGERS substring ("research X", "look up Y"),
  // which would otherwise silently steal the turn into deep_thoughtful
  // before this check ever ran and the explicit phrase would stop working
  // for exactly the examples CAPABILITIES.md gives for it. forcedDeepThoughtful
  // ("dt:") is an even more explicit, typed-not-spoken override and still
  // wins over this, same precedence as it has over everything else.
  if (mode === "friendly" && !forcedDeepThoughtful) {
    const explicitDelegate = matchExplicitDelegate(transcript);
    if (explicitDelegate) {
      const callModel = createMessage ?? ((params) => anthropic.messages.create(params));
      const longTermBlockForAck = getLongTermMemoryBlock(activePersonality);
      const title = await deriveDelegateTitle(explicitDelegate.instruction, callModel);
      const { id } = createDelegatedTask({ title, request: explicitDelegate.instruction });
      log("friendly: task delegated via explicit phrase", { id, title, phrase: explicitDelegate.phrase });
      const { line, usage } = await generateDelegateAck(systemPrompt, longTermBlockForAck, title, callModel);

      appendTurn(ws, "user", transcript);
      appendTurn(ws, "assistant", line);

      return {
        kind: "text",
        transcript,
        effectiveMode: "friendly",
        line,
        model: LLM_CHOICES.haiku.model,
        provider: "api",
        personality: activePersonality,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        },
        llmRounds: 1,
        webSearches: 0,
        deepReason: null,
        toolCalls: [],
        pendingGithubWrite: Boolean(ws.pendingGithubWrite),
      };
    }
  }

  // Server-side-only override. Either one explicitly marked turn ("dt:"), or
  // a phrase-triggered sticky run capped at DEEP_THOUGHTFUL_STICKY_TURNS
  // turns — see resolveEffectiveMode.
  const effectiveMode = resolveEffectiveMode(ws, mode, transcript, forcedDeepThoughtful);

  // "Remember this"-style utterances get real agency over what's saved, but
  // only in modes with tool access (friendly, deep_thoughtful — see
  // TOOL_ENABLED_MODES below): the turn runs live with save_memory offered,
  // and the model decides what's worth keeping and calls it itself, in its
  // own words, before replying. In modes with no tool access (sentry_intruder,
  // bump_complaint) there's no live tool call available, so this falls back
  // to the old instant canned ack + background condensation-by-a-different-
  // model path instead.
  // The classifier is only allowed to run in modes that could actually act on
  // a positive result. sentry_intruder and bump_complaint fall back to the
  // canned ack below, which the cheap certain-phrase tier already detects —
  // so letting them reach the classification call would add a serial API
  // round-trip to the critical path for an answer that changes nothing.
  const toolsAvailableThisTurn = TOOL_ENABLED_MODES.has(effectiveMode);
  const memoryTriggered = await isMemoryTrigger(transcript, {
    allowClassifier: toolsAvailableThisTurn,
  });
  const memoryToolAvailable = memoryTriggered && toolsAvailableThisTurn;
  if (memoryTriggered && !memoryToolAvailable) {
    const category = "custom-memory_saved";
    const result = getCannedResponse(effectiveMode, category);
    condenseAndStore(activePersonality, getTurns(ws), transcript);
    return { kind: "canned", transcript, effectiveMode, category, ...result };
  }

  // Whether THIS personality is allowed anywhere near the self-improvement
  // pipeline this turn. False for every personality not explicitly named in
  // config.json's self_improve_personalities — those get deep_thoughtful
  // mode's other abilities (web search, GitHub/Gmail/Calendar tools) same as
  // anyone else, just with no trace of self-improvement in their context.
  const selfImproveApproved =
    effectiveMode === "deep_thoughtful" && isSelfImproveApproved(activePersonality);
  const longTermBlock = getLongTermMemoryBlock(activePersonality);
  const capabilitiesBlock =
    effectiveMode === "deep_thoughtful" ? getCapabilitiesBlock(selfImproveApproved) : "";
  const insightsBlock =
    effectiveMode === "deep_thoughtful" ? getApprovedInsightsBlock(activePersonality) : "";
  const selfProposalsBlock = selfImproveApproved ? getSelfProposalsBlock() : "";
  const outputFormatBlock = selfImproveApproved ? SELF_PROPOSAL_OUTPUT_FORMAT : "";
  // Titles only, never full results — a nudge so the model knows there's
  // something to mention if asked, not an invitation to read the list out
  // unprompted; actual titles come from the list_tasks tool.
  const unheardTasksBlock = effectiveMode === "friendly" ? `Unheard tasks: ${countUnheardTasks()}` : "";
  // Stable across turns first (cached), per-turn after (see buildSystemBlocks).
  const stableSystemPrompt = [
    systemPrompt,
    longTermBlock,
    capabilitiesBlock,
    insightsBlock,
    selfProposalsBlock,
    outputFormatBlock,
    SPOKEN_SEARCH_RULE,
    TIME_RULE,
  ]
    .filter(Boolean)
    .join("\n\n");
  const volatileSystemPrompt = [unheardTasksBlock, searchedRepliesBlock(ws)].filter(Boolean).join("\n\n");
  const fullSystemPrompt = [stableSystemPrompt, volatileSystemPrompt].filter(Boolean).join("\n\n");
  const systemBlocks = buildSystemBlocks(stableSystemPrompt, volatileSystemPrompt);

  const { model, thinking } = resolveLlm(readConfig(), effectiveMode);
  const maxTokens =
    effectiveMode === "deep_thoughtful" ? DEEP_THOUGHTFUL_MAX_TOKENS : DEFAULT_MAX_TOKENS;

  const t0 = Date.now();
  const userTurnContent = withTimeTag(
    memoryToolAvailable
      ? `[MODE: ${effectiveMode}] Person said: "${transcript}" — this is an explicit request to remember/persist something. Before replying, decide what's actually worth keeping from this conversation and call save_memory yourself (your own wording, your own tags). Then confirm in your reply what you saved.`
      : `[MODE: ${effectiveMode}] Person said: "${transcript}"`,
    ws,
    readConfig(),
  );

  // Two independent ways into the Claude Code path: deep_thoughtful's own
  // loop, gated by DEEP_THOUGHTFUL_PROVIDER (see deepThoughtfulProvider()
  // above); and friendly mode's ordinary chat, gated per-personality by
  // config.json's claude_code_chat_personalities (isClaudeCodeChatApproved) —
  // an operator can route a specific personality's everyday conversation
  // through their Claude Pro/Max/Team subscription instead of the metered
  // Anthropic API. sentry_intruder/bump_complaint are never affected by
  // either — see the scope note on TOOL_ENABLED_MODES.
  const useClaudeCode =
    (effectiveMode === "deep_thoughtful" && deepThoughtfulProvider() === "claude-code") ||
    (effectiveMode === "friendly" && isClaudeCodeChatApproved(activePersonality));
  if (useClaudeCode && !claudeCodeIsSubscriptionBilled()) {
    // Refuse rather than spend API money: without CLAUDE_CODE_OAUTH_TOKEN,
    // query() would still run — successfully — but authenticated with the
    // inherited ANTHROPIC_API_KEY, i.e. exactly the metered spend this
    // routing was turned on specifically to avoid. Fail before any call is
    // attempted rather than let that happen even once; set
    // CLAUDE_CODE_OAUTH_TOKEN (see README's `claude setup-token` step) to
    // make this mode work again.
    const msg =
      `${effectiveMode}: routed to run via Claude Code but CLAUDE_CODE_OAUTH_TOKEN is not set — refusing to run this turn rather than fall back to the metered Anthropic API. Run \`claude setup-token\` and set CLAUDE_CODE_OAUTH_TOKEN in .env.`;
    log(msg, { transcript });
    throw new Error(msg);
  }
  // Captured before the loop runs so the post-loop expiry check below can
  // tell "a proposal that already existed when this turn started" apart
  // from "a proposal github_propose_write just created during this very
  // turn" — see that check for why the distinction matters.
  const pendingGithubWriteAtTurnStart = ws.pendingGithubWrite;
  let provider = "api";
  let rawText, usageTotals, toolCallNames, llmRounds, webSearches, confirmWriteCalledThisTurn;
  if (useClaudeCode) {
    try {
      ({ rawText, usageTotals, toolCallNames, llmRounds, webSearches, confirmWriteCalledThisTurn } =
        await runViaClaudeCode({ ws, activePersonality, effectiveMode, fullSystemPrompt, priorTurns: getTurns(ws), userTurnContent, memoryToolAvailable, model }));
      // Always "claude-code" here, never "claude-code-metered" — the
      // no-subscription-token case is refused above, before this call is
      // ever reached, so every runViaClaudeCode call that gets this far is
      // genuinely subscription-billed.
      provider = "claude-code";
    } catch (err) {
      const fallback = allowClaudeCodeApiFallback();
      log(
        fallback
          ? `${effectiveMode}: claude-code call failed — ALLOW_CLAUDE_CODE_API_FALLBACK is set, retrying via the metered Anthropic API`
          : `${effectiveMode}: claude-code call failed — surfacing error (set ALLOW_CLAUDE_CODE_API_FALLBACK=true to retry via the metered API instead)`,
        { error: err?.message ?? String(err), transcript },
      );
      if (!fallback) throw err;
      ({ rawText, usageTotals, toolCallNames, llmRounds, webSearches, confirmWriteCalledThisTurn } =
        await runViaAnthropicApi({ ws, effectiveMode, fullSystemPrompt, systemBlocks, model, thinking, maxTokens, priorTurns: getTurns(ws), userTurnContent, activePersonality, memoryToolAvailable }));
      provider = "api";
    }
  } else {
    ({ rawText, usageTotals, toolCallNames, llmRounds, webSearches, confirmWriteCalledThisTurn } =
      await runViaAnthropicApi({ ws, effectiveMode, fullSystemPrompt, systemBlocks, model, thinking, maxTokens, priorTurns: getTurns(ws), userTurnContent, activePersonality, memoryToolAvailable, createMessage }));
  }

  // Single-shot expiry: a pending proposal survives only into the one turn
  // immediately after it was made. If that turn didn't confirm it, it's
  // gone — an unrelated "yes" three exchanges later can't confirm a stale
  // proposal nobody meant to approve anymore. Same reasoning as why sticky
  // deep_thoughtful mode has an explicit exit rather than lasting forever
  // with no way out.
  //
  // The `ws.pendingGithubWrite === pendingGithubWriteAtTurnStart` guard is
  // load-bearing, not defensive: without it, a proposal github_propose_write
  // creates THIS turn (a brand-new object, never equal to whatever was
  // pending at turn start — null, most commonly) would satisfy
  // `ws.pendingGithubWrite && !confirmWriteCalledThisTurn` and get wiped out
  // immediately, before the very next turn (the only turn confirmation is
  // ever allowed in) had a chance to see it. runCustomTool's confirm branch
  // already nulls ws.pendingGithubWrite itself on a successful confirm, so
  // this check only ever has real work to do when a proposal from a PRIOR
  // turn survived, unconfirmed and unreplaced, into this one.
  if (memoryToolAvailable && !toolCallNames.includes("save_memory")) {
    log("long-term memory: save_memory offered but never called", { activePersonality, transcript });
  }
  if (
    ws.pendingGithubWrite &&
    ws.pendingGithubWrite === pendingGithubWriteAtTurnStart &&
    !confirmWriteCalledThisTurn
  ) {
    log("deep_thoughtful: github write proposal expired unconfirmed", {
      owner: ws.pendingGithubWrite.owner,
      repo: ws.pendingGithubWrite.repo,
      path: ws.pendingGithubWrite.path,
    });
    ws.pendingGithubWrite = null;
  }
  timings.llm = Date.now() - t0;

  // Only parse for the {reply, propose_task} JSON shape when this turn's
  // system prompt actually asked for it (outputFormatBlock, gated above on
  // selfImproveApproved) — an unapproved personality's plain-text reply is
  // the final line as-is, never run through propose_task handling.
  let line = rawText;
  if (selfImproveApproved) {
    const parsed = parseDeepThoughtfulOutput(rawText);
    line = parsed.reply;
    if (parsed.proposeTask) {
      writeSelfAuthoredTask(parsed.proposeTask);
    }
  }

  appendTurn(ws, "user", transcript);
  appendTurn(ws, "assistant", line);
  // Email/calendar/other tool lookups count too: "I quoted email figures
  // without checking them" was said about an answer from gmail_search.
  if (webSearches > 0 || (toolCallNames?.length ?? 0) > 0) noteSearchedReply(ws, line);

  return {
    kind: "text",
    transcript,
    effectiveMode,
    line,
    // Telemetry for the turn log — see src/turnLog.js. Carried on the result
    // rather than written here so the record is emitted once, by the caller,
    // after the response is already on the wire.
    model,
    provider,
    personality: activePersonality,
    usage: usageTotals,
    llmRounds,
    webSearches,
    deepReason: ws.deepThoughtfulReason ?? null,
    toolCalls: TOOL_ENABLED_MODES.has(effectiveMode) ? toolCallNames : undefined,
    // Whether a GitHub write proposal is still live going into the NEXT
    // turn on this connection — lets callers (scripts/test-client.js in
    // particular) verify the propose/confirm/expiry state machine directly
    // rather than inferring it from reply text.
    pendingGithubWrite:
      TOOL_ENABLED_MODES.has(effectiveMode) ? Boolean(ws.pendingGithubWrite) : undefined,
  };
}

// audioBuffer: raw 16kHz mono 16-bit PCM bytes from the bot.
// Returns one of:
//   { kind: "speech", transcript, line, audio, toolCalls, pendingGithubWrite }   — normal conversational turn
//   { kind: "canned", transcript, ok: true, lineId, bytes }   — memory-trigger ack
//   { kind: "canned", transcript, ok: false, reason }         — memory-trigger ack, no audio on disk yet
// Throws on failure at any stage of the "speech" path — the caller is
// responsible for turning that into a speech_error + pushed pipeline_error
// canned response.
// `stt` and `tts` are seams so the pipeline is testable offline, same
// pattern as runViaAnthropicApi's `createMessage` — default to the real
// metered call, never mocked in place. `createMessage` is forwarded to
// runTextPipeline for the same reason.
// TTS for a line that didn't come from a speech turn (robot announcements): same voice, model
// and per-mode speed as runSpeechPipeline's reply.
export async function synthesizeLine(line, effectiveMode, tts = elevenlabs.textToSpeech) {
  const { voice_id, model, speed } = loadActivePersonality();
  const ttsStream = await tts.convert(voice_id, {
    text: line,
    modelId: model ?? TTS_MODEL,
    outputFormat: "pcm_16000",
    voiceSettings: { speed: resolveVoiceSpeed(speed, effectiveMode) },
  });
  return Buffer.from(await new Response(ttsStream).arrayBuffer());
}

export async function runSpeechPipeline(
  ws,
  mode,
  audioBuffer,
  timings,
  stt = elevenlabs.speechToText,
  tts = elevenlabs.textToSpeech,
  { createMessage, liveTranscript } = {},
) {
  let t0 = Date.now();
  // A streamed question may already be transcribed live (src/liveStt.js).
  if (typeof liveTranscript === "string" && liveTranscript.trim()) {
    timings.stt = 0;
    timings.sttLive = true;
    return finishSpeechTurn(ws, mode, liveTranscript, timings, tts, createMessage);
  }
  const sttResult = await stt.convert({
    file: audioBuffer,
    modelId: STT_MODEL,
    // Bot audio is already 16kHz/mono/16-bit PCM — this skips re-encoding
    // and gets lower STT latency than passing it as an encoded waveform.
    fileFormat: "pcm_s16le_16",
    // Pin English: short or clipped utterances were being auto-detected as other languages
    // (a cut-off "in my emails" came back as Dutch "En in uw e-mails").
    languageCode: "en",
    // The bot sends "Hey Gatsby, <question>" in one breath as a single clip; without biasing,
    // the wake phrase came back as "Against be ..." / "He can't speak ...".
    keyterms: ["Gatsby", "Hey Gatsby"],
  });
  const transcript = sttResult.text;
  timings.stt = Date.now() - t0;
  return finishSpeechTurn(ws, mode, transcript, timings, tts, createMessage);
}

async function finishSpeechTurn(ws, mode, transcript, timings, tts, createMessage) {
  let t0;
  // Silence / noise-only audio: skip Claude, TTS and session memory entirely.
  const noSpeech = noSpeechResult(transcript);
  if (noSpeech) return noSpeech;

  const result = await runTextPipeline(ws, mode, transcript, timings, { createMessage });
  if (result.kind === "canned") {
    return result;
  }

  const { effectiveMode, line, toolCalls, pendingGithubWrite } = result;
  // Re-read rather than threaded through runTextPipeline: that function has
  // no TTS-side need for voice_id, and personality config is already
  // re-read fresh on every call throughout this module (no fs.watch/caching
  // anywhere), so this costs nothing extra to keep the two paths decoupled.
  const { voice_id, model, speed } = loadActivePersonality();

  t0 = Date.now();
  const ttsStream = await tts.convert(voice_id, {
    text: line,
    modelId: model ?? TTS_MODEL,
    outputFormat: "pcm_16000",
    voiceSettings: { speed: resolveVoiceSpeed(speed, effectiveMode) },
  });
  const audio = Buffer.from(await new Response(ttsStream).arrayBuffer());
  timings.tts = Date.now() - t0;

  // Spread the text-pipeline result so its telemetry (model, personality,
  // usage, llmRounds, webSearches, deepReason — see src/turnLog.js) survives
  // the speech path too, then override kind and attach the audio. Listing
  // the fields explicitly here is what previously dropped them.
  return { ...result, kind: "speech", transcript, effectiveMode, line, audio, toolCalls, pendingGithubWrite };
}

