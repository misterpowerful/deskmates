import test from "node:test";
import assert from "node:assert/strict";
import { noteSearchedReply, getSearchedReplies, clearTurns } from "../../src/sessionMemory.js";

// The system prompt goes to the API as cached text blocks; tests read it as one string.
const systemText = (params) => (typeof params.system === "string" ? params.system : params.system.map((b) => b.text).join("\n\n"));

// speechPipeline builds its API clients at import time; dummy keys, no network.
async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("search answer pieces get a space where a new sentence starts, and none mid-sentence", async () => {
  const { joinTextBlocks } = await loadSpeechPipeline();
  assert.equal(
    joinTextBlocks(["though Kane has slipped from his MVP days.", "Chicago dropped five of six", ", and", " that is grim."]),
    "though Kane has slipped from his MVP days. Chicago dropped five of six, and that is grim.",
  );
});

test("replies noted as searched are kept per connection and cleared with its turns", () => {
  const ws = {};
  noteSearchedReply(ws, "The Hawks are 1-5-0.");
  assert.deepEqual(getSearchedReplies(ws), ["The Hawks are 1-5-0."]);
  const session = { sessionId: "search-note-green" };
  noteSearchedReply(session, "Bedard debuts Tuesday.");
  assert.deepEqual(getSearchedReplies(session), ["Bedard debuts Tuesday."]);
  clearTurns(ws);
  clearTurns(session);
  assert.deepEqual(getSearchedReplies(ws), []);
  assert.deepEqual(getSearchedReplies(session), []);
});

test("a turn that used web search is remembered, and the next turn's prompt says so", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const ws = {};
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    return calls.length === 1
      ? { content: [{ type: "text", text: "The Hawks are 1-5-0." }], usage: { server_tool_use: { web_search_requests: 1 } } }
      : { content: [{ type: "text", text: "As I said." }], usage: {} };
  };
  await runTextPipeline(ws, "friendly", "how are the hawks doing", {}, { createMessage });
  await runTextPipeline(ws, "friendly", "did you check that?", {}, { createMessage });
  assert.match(systemText(calls[0]), /say each fact once/);
  assert.match(systemText(calls[1]), /LIVE LOOKUP[\s\S]*The Hawks are 1-5-0\./);
});

test("an answer from an email or calendar lookup is remembered as checked, like a web search", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const ws = {};
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    if (calls.length === 1) return { content: [{ type: "tool_use", id: "toolu_t1", name: "list_tasks", input: {} }], usage: {} };
    if (calls.length === 2) return { content: [{ type: "text", text: "The lunch wallet is at minus 15.60." }], usage: {} };
    return { content: [{ type: "text", text: "Yes, I checked." }], usage: {} };
  };
  await runTextPipeline(ws, "friendly", "what's in my email", {}, { createMessage });
  await runTextPipeline(ws, "friendly", "did you check that?", {}, { createMessage });
  assert.match(systemText(calls[2]), /LIVE LOOKUP[\s\S]*lunch wallet is at minus 15\.60/);
});
