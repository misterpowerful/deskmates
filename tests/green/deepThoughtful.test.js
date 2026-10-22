import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveMode,
  parseDeepThoughtfulOutput,
  stripDeepThoughtfulPrefix,
  DEEP_THOUGHTFUL_STICKY_TURNS,
  SELF_PROPOSAL_OUTPUT_FORMAT,
} from "../../src/deepThoughtful.js";

test("a trigger phrase engages sticky deep_thoughtful", () => {
  const conn = {};
  assert.equal(resolveEffectiveMode(conn, "friendly", "please think carefully about this"), "deep_thoughtful");
  assert.equal(conn.deepThoughtfulSticky, true);
  assert.equal(conn.deepThoughtfulTurnsRemaining, DEEP_THOUGHTFUL_STICKY_TURNS - 1);
});

test("stickiness persists without re-triggering, then expires after the budget", () => {
  const conn = {};
  resolveEffectiveMode(conn, "friendly", "think deeply");
  for (let i = 0; i < DEEP_THOUGHTFUL_STICKY_TURNS - 1; i++) {
    assert.equal(resolveEffectiveMode(conn, "friendly", "and another thing"), "deep_thoughtful");
  }
  assert.equal(resolveEffectiveMode(conn, "friendly", "and another thing"), "friendly");
  assert.equal(conn.deepThoughtfulSticky, false);
});

test("an exit phrase clears the sticky state and that turn is not deep_thoughtful", () => {
  const conn = {};
  resolveEffectiveMode(conn, "friendly", "think deeply");
  assert.equal(resolveEffectiveMode(conn, "friendly", "ok go back to normal"), "friendly");
  assert.equal(conn.deepThoughtfulSticky, false);
});

test("an ordinary sentence stays friendly", () => {
  assert.equal(resolveEffectiveMode({}, "friendly", "how are you today"), "friendly");
});

test("the dt: prefix forces one turn without starting stickiness", () => {
  const conn = {};
  const { transcript, forced } = stripDeepThoughtfulPrefix("dt: what is love");
  assert.deepEqual({ transcript, forced }, { transcript: "what is love", forced: true });
  assert.equal(resolveEffectiveMode(conn, "friendly", transcript, forced), "deep_thoughtful");
  assert.notEqual(conn.deepThoughtfulSticky, true);
});

test("parseDeepThoughtfulOutput reads well-formed JSON", () => {
  const out = parseDeepThoughtfulOutput('{"reply":"Hello there","propose_task":{"title":" T ","description":" D "}}');
  assert.deepEqual(out, { reply: "Hello there", proposeTask: { title: "T", description: "D" } });
});

test("parseDeepThoughtfulOutput reads fenced JSON", () => {
  const out = parseDeepThoughtfulOutput('```json\n{"reply":"Hi","propose_task":null}\n```');
  assert.deepEqual(out, { reply: "Hi", proposeTask: null });
});

test("parseDeepThoughtfulOutput recovers the reply from near-miss JSON", () => {
  const out = parseDeepThoughtfulOutput('{"reply": "Recovered text", "propose_task": {oops');
  assert.deepEqual(out, { reply: "Recovered text", proposeTask: null });
});

test("plain text passes through as the reply", () => {
  assert.deepEqual(parseDeepThoughtfulOutput("just words"), { reply: "just words", proposeTask: null });
});

test("SELF_PROPOSAL_OUTPUT_FORMAT routes explicit queue requests to the queue_task tool, not propose_task", () => {
  assert.match(SELF_PROPOSAL_OUTPUT_FORMAT, /call the queue_task tool/);
  assert.match(SELF_PROPOSAL_OUTPUT_FORMAT, /leave propose_task null/);
});

test("parseDeepThoughtfulOutput passes a user-specified queued task through with its full description", () => {
  const description = "Drawer UI. (1) slide-in (2) drag reorder (3) persist order.";
  const out = parseDeepThoughtfulOutput(JSON.stringify({ reply: "Queued.", propose_task: { title: "Queue drawer", description } }));
  assert.deepEqual(out, { reply: "Queued.", proposeTask: { title: "Queue drawer", description } });
});

// speechPipeline builds its API clients at import time, so give them dummy
// keys — nothing here makes a network call.
async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("speechPipeline loads offline and reports the deep_thoughtful provider", async () => {
  const { deepThoughtfulProvider } = await loadSpeechPipeline();
  const prev = process.env.DEEP_THOUGHTFUL_PROVIDER;
  try {
    process.env.DEEP_THOUGHTFUL_PROVIDER = "claude-code";
    assert.equal(deepThoughtfulProvider(), "claude-code");
    delete process.env.DEEP_THOUGHTFUL_PROVIDER;
    assert.equal(deepThoughtfulProvider(), "api");
  } finally {
    if (prev === undefined) delete process.env.DEEP_THOUGHTFUL_PROVIDER;
    else process.env.DEEP_THOUGHTFUL_PROVIDER = prev;
  }
});

test("asking to look something up stays on the fast friendly path, which has web search", () => {
  for (const ask of ["can you look it up?", "look that up for me", "research the Blackhawks", "find out the score"]) {
    assert.equal(resolveEffectiveMode({}, "friendly", ask), "friendly", ask);
  }
  assert.equal(resolveEffectiveMode({}, "friendly", "think hard about the Blackhawks"), "deep_thoughtful");
});
