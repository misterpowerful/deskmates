import test from "node:test";
import assert from "node:assert/strict";
import { readConfig, resolveLlm } from "../../src/config.js";

// speechPipeline builds its API clients at import time; dummy keys, no network.
async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("runTextPipeline forwards the active_llm's resolved model/thinking to the Anthropic request", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    return { content: [{ type: "text", text: "Hi there." }], usage: {} };
  };

  const result = await runTextPipeline({}, "friendly", "hello, nice weather today", {}, { createMessage });

  assert.equal(result.kind, "text");
  assert.equal(result.line, "Hi there.");
  assert.equal(calls.length, 1);

  // Ties the wiring to whatever resolveLlm actually computes for this
  // checkout's current config.json, rather than hard-coding a model name —
  // resolveLlm's own branches are already covered in tests/green/llmSwitcher.test.js.
  const expected = resolveLlm(readConfig(), result.effectiveMode);
  assert.equal(calls[0].model, expected.model);
  if (expected.thinking) {
    assert.deepEqual(calls[0].thinking, expected.thinking);
  } else {
    assert.equal("thinking" in calls[0], false);
  }
});
