import test from "node:test";
import assert from "node:assert/strict";

async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("a plain reply sends no progress, and a throwing listener never breaks a tool turn", async () => {
  const { runTextPipeline, notifyToolProgress } = await loadSpeechPipeline();
  const progress = [];
  await runTextPipeline({ onTurnProgress: (p) => progress.push(p) }, "friendly", "hello", {}, {
    createMessage: async () => ({ content: [{ type: "text", text: "Hello." }], usage: {} }),
  });
  assert.deepEqual(progress, []);

  let round = 0;
  const result = await runTextPipeline({ onTurnProgress: () => { throw new Error("socket gone"); } }, "friendly", "anything finished?", {}, {
    createMessage: async () => {
      round += 1;
      return round === 1
        ? { content: [{ type: "tool_use", id: "toolu_2", name: "list_tasks", input: {} }], usage: {} }
        : { content: [{ type: "text", text: "Still nothing." }], usage: {} };
    },
  });
  assert.equal(result.line, "Still nothing.");
  assert.doesNotThrow(() => notifyToolProgress(undefined, ["x"]));
  assert.doesNotThrow(() => notifyToolProgress({}, ["x"]));
});
