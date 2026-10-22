import test from "node:test";
import assert from "node:assert/strict";

async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("a turn that calls a tool tells the connection before the tool runs", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const progress = [];
  const ws = { onTurnProgress: (p) => progress.push(p) };
  let round = 0;
  const createMessage = async () => {
    round += 1;
    return round === 1
      ? { content: [{ type: "tool_use", id: "toolu_1", name: "list_tasks", input: {} }], usage: {} }
      : { content: [{ type: "text", text: "Nothing pending." }], usage: {} };
  };
  await runTextPipeline(ws, "friendly", "anything finished?", {}, { createMessage });
  assert.deepEqual(progress, [{ stage: "tool", tools: ["list_tasks"] }]);
});
