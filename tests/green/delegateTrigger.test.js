import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeFakeClaudeBin, fakeSuccessEnvelope, waitForAllDelegatedTasksSettled } from "../helpers/fakeClaude.js";

// The system prompt goes to the API as cached text blocks; tests read it as one string.
const systemText = (params) => (typeof params.system === "string" ? params.system : params.system.map((b) => b.text).join("\n\n"));

// speechPipeline builds its API clients at import time; dummy keys, no network.
async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

process.env.CLAUDE_BIN = makeFakeClaudeBin();
process.env.FAKE_CLAUDE_RESPONSE = fakeSuccessEnvelope();

test("an explicit 'delegate this' phrase in friendly mode skips the normal tool loop: it derives a title, creates the task, and speaks only a short ack", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const { listTasks, DELEGATED_TASKS_DIR } = await import("../../src/delegatedTasks.js");
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    if (calls.length === 1) return { content: [{ type: "text", text: "Summarize my inbox" }], usage: {} };
    return { content: [{ type: "text", text: "On it, boss." }], usage: { input_tokens: 5, output_tokens: 3 } };
  };

  try {
    const result = await runTextPipeline({}, "friendly", "delegate this: summarize my inbox", {}, { createMessage });
    assert.equal(result.kind, "text");
    assert.equal(result.line, "On it, boss.");
    assert.equal(calls.length, 2);
    // Neither call offered tools — this path is a plain acknowledgment, not
    // a tool-enabled turn.
    assert.equal("tools" in calls[0], false);
    assert.equal("tools" in calls[1], false);
    assert.ok(listTasks({ includeHeard: true }).some((t) => t.title === "Summarize my inbox"));
  } finally {
    await waitForAllDelegatedTasksSettled(listTasks);
    fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
  }
});

test("'hand this off' is recognized the same way as 'delegate this'", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const { DELEGATED_TASKS_DIR, listTasks } = await import("../../src/delegatedTasks.js");
  const createMessage = async () => ({ content: [{ type: "text", text: "Sure thing." }], usage: {} });

  try {
    const result = await runTextPipeline({}, "friendly", "hand this off: book a dentist appointment", {}, { createMessage });
    assert.equal(result.kind, "text");
    assert.equal(result.line, "Sure thing.");
  } finally {
    await waitForAllDelegatedTasksSettled(listTasks);
    fs.rmSync(DELEGATED_TASKS_DIR, { recursive: true, force: true });
  }
});

test("Unheard tasks context line is present on an ordinary friendly turn", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    return { content: [{ type: "text", text: "Hello." }], usage: {} };
  };
  await runTextPipeline({}, "friendly", "how's the weather looking", {}, { createMessage });
  assert.match(systemText(calls[0]), /Unheard tasks: \d+/);
});

test("a custom tool the model calls mid-turn runs and its tool_result goes back on the next round", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const calls = [];
  const createMessage = async (params) => {
    calls.push(params);
    if (calls.length === 1) {
      return {
        content: [{ type: "tool_use", id: "toolu_list_1", name: "list_tasks", input: {} }],
        usage: {},
      };
    }
    return { content: [{ type: "text", text: "Nothing waiting for you." }], usage: {} };
  };
  const result = await runTextPipeline({}, "friendly", "anything finished yet?", {}, { createMessage });
  assert.equal(result.kind, "text");
  assert.equal(result.line, "Nothing waiting for you.");
  assert.equal(calls.length, 2);
  const toolResults = calls[1].messages.at(-1).content;
  assert.equal(toolResults[0].type, "tool_result");
  assert.equal(toolResults[0].tool_use_id, "toolu_list_1");
  assert.equal(toolResults[0].is_error, undefined);
  assert.ok(Array.isArray(JSON.parse(toolResults[0].content)));
});
