import test from "node:test";
import assert from "node:assert/strict";

async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("the stable system prompt is sent as a cached block, the per-turn part after it uncached", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    return { content: [{ type: "text", text: "Hello." }], usage: {} };
  };
  await runTextPipeline({}, "friendly", "how are things", {}, { createMessage });
  const [stable, volatile] = calls[0].system;
  assert.deepEqual(stable.cache_control, { type: "ephemeral" });
  assert.equal(volatile.cache_control, undefined);
  assert.match(volatile.text, /Unheard tasks: \d+/);
  assert.doesNotMatch(stable.text, /Unheard tasks/);
});

test("the last message carries a cache breakpoint without changing what's stored", async () => {
  const { withMessageCacheBreakpoint } = await loadSpeechPipeline();
  const stored = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "[TIME: x] what's on today?" },
  ];
  const sent = withMessageCacheBreakpoint(stored);
  assert.deepEqual(sent[2].content, [{ type: "text", text: "[TIME: x] what's on today?", cache_control: { type: "ephemeral" } }]);
  assert.equal(stored[2].content, "[TIME: x] what's on today?", "stored turn untouched");
  assert.equal(sent[0], stored[0]);
});
