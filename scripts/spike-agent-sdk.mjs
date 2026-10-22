// Throwaway Phase-2 verification spike (not part of the app) — confirms,
// against the real installed @anthropic-ai/claude-agent-sdk package:
//   1. our tool bridge round-trips a tool_result correctly, including the
//      is_error path
//   2. the real SDKAssistantMessage/SDKResultMessage shapes match what
//      src/turnLog.js expects (usage.{input_tokens,...}, num_turns)
//   3. the `env` option actually overrides the subprocess environment
// Run with: node scripts/spike-agent-sdk.mjs
import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDeskmatesMcpServer } from "../src/tools/agentSdkBridge.js";

const ws = {};
const server = createDeskmatesMcpServer(ws, "test-personality", { memoryTriggered: false });

// No CLAUDE_CODE_OAUTH_TOKEN exists yet (manual setup, out of band — see the
// plan), so this spike just inherits process.env (ANTHROPIC_API_KEY) by
// omitting `env` entirely, exactly like the SDK's documented default. This
// spike is only proving tool-bridge mechanics and message shapes, not the
// billing switch itself.
let sawToolUse = false;
let sawToolResult = false;
let sawErrorToolUse = false;
let finalResult = null;
const assistantUsages = [];

for await (const message of query({
  prompt:
    "Call the local_list_directory tool with path '.' exactly once. Then call local_read_file with path 'does/not/exist.txt' and note that it errors. Then, in plain text (not JSON), say DONE.",
  options: {
    systemPrompt: "You are a tool-calling test harness. Follow the user's instructions literally and exactly.",
    settingSources: [],
    tools: [],
    mcpServers: { deskmates: server },
    canUseTool: async () => ({ behavior: "allow" }),
    persistSession: false,
    model: "claude-haiku-4-5-20251001",
  },
})) {
  if (message.type === "assistant") {
    assistantUsages.push(message.message.usage);
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        sawToolUse = true;
        console.log("tool_use:", block.name, JSON.stringify(block.input));
      }
    }
  }
  if (message.type === "user") {
    for (const block of message.message.content ?? []) {
      if (block.type === "tool_result") {
        sawToolResult = true;
        if (block.is_error) sawErrorToolUse = true;
        console.log("tool_result:", JSON.stringify(block).slice(0, 200));
      }
    }
  }
  if (message.type === "result") {
    finalResult = message;
  }
}

console.log("\n--- Spike summary ---");
console.log("sawToolUse:", sawToolUse);
console.log("sawToolResult:", sawToolResult);
console.log("sawErrorToolUse (from the bad local_read_file call):", sawErrorToolUse);
console.log("final result subtype:", finalResult?.subtype);
console.log("final result text:", finalResult?.result);
console.log("final result num_turns (-> llmRounds):", finalResult?.num_turns);
console.log("final result usage (-> turnLog usage shape):", JSON.stringify(finalResult?.usage));
console.log("assistant message usages seen per-round:", JSON.stringify(assistantUsages));
console.log("ws.pendingGithubWrite (should be undefined, no github tool called):", ws.pendingGithubWrite);
