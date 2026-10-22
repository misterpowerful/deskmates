import test from "node:test";
import assert from "node:assert/strict";
import { noteSearchedReply, getSearchedReplies, MAX_SEARCHED_REPLIES } from "../../src/sessionMemory.js";

async function loadSpeechPipeline() {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  return import("../../src/speechPipeline.js");
}

test("joining never splits decimals or adds spaces before punctuation or digits", async () => {
  const { joinTextBlocks } = await loadSpeechPipeline();
  assert.equal(joinTextBlocks(["averaging 2.", "56 goals a game."]), "averaging 2.56 goals a game.");
  assert.equal(joinTextBlocks(["Done.", "", "  "]), "Done.");
  assert.equal(joinTextBlocks([]), "");
  assert.equal(joinTextBlocks(['He said "go."', '"Fine," I said.']), 'He said "go." "Fine," I said.');
});

test("the searched-replies list is capped, trims long replies, and ignores empty ones", () => {
  const ws = {};
  noteSearchedReply(ws, "");
  noteSearchedReply(ws, "   ");
  noteSearchedReply(ws, undefined);
  assert.deepEqual(getSearchedReplies(ws), []);
  for (let i = 0; i < MAX_SEARCHED_REPLIES + 3; i++) noteSearchedReply(ws, `reply ${i}`);
  assert.equal(getSearchedReplies(ws).length, MAX_SEARCHED_REPLIES);
  assert.equal(getSearchedReplies(ws).at(-1), `reply ${MAX_SEARCHED_REPLIES + 2}`);
  noteSearchedReply(ws, "x".repeat(1000));
  assert.ok(getSearchedReplies(ws).at(-1).length < 200);
  assert.deepEqual(getSearchedReplies({ sessionId: "never-used-search-session" }), []);
});

test("a turn with no web search adds nothing to the searched list", async () => {
  const { runTextPipeline } = await loadSpeechPipeline();
  const ws = {};
  const createMessage = async () => ({ content: [{ type: "text", text: "Hello." }], usage: {} });
  await runTextPipeline(ws, "friendly", "hello there", {}, { createMessage });
  assert.deepEqual(getSearchedReplies(ws), []);
});
