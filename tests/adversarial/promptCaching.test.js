import test from "node:test";
import assert from "node:assert/strict";

async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("per-turn details never leak into the cached block, so it stays identical from turn to turn", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const ws = {};
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    return calls.length === 1
      ? { content: [{ type: "text", text: "The Hawks are 1-5-0." }], usage: { server_tool_use: { web_search_requests: 1 } } }
      : { content: [{ type: "text", text: "Indeed." }], usage: {} };
  };
  await runTextPipeline(ws, "friendly", "how are the hawks", {}, { createMessage });
  await runTextPipeline(ws, "friendly", "and tomorrow?", {}, { createMessage });
  assert.equal(calls[0].system[0].text, calls[1].system[0].text);
  assert.match(calls[1].system[1].text, /LIVE LOOKUP/);
});

test("tool-result rounds and empty histories get a breakpoint without breaking the message shape", async () => {
  const { withMessageCacheBreakpoint, buildSystemBlocks } = await loadSpeechPipeline();
  assert.deepEqual(withMessageCacheBreakpoint([]), []);
  const toolRound = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] }];
  const sent = withMessageCacheBreakpoint(toolRound);
  assert.deepEqual(sent[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(toolRound[0].content[0].cache_control, undefined);
  assert.deepEqual(withMessageCacheBreakpoint([{ role: "user", content: [] }]), [{ role: "user", content: [] }]);
  assert.equal(buildSystemBlocks("stable", "").length, 1);
});
