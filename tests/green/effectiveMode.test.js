import test from "node:test";
import assert from "node:assert/strict";
import { displayModeFor, isDeepThoughtful } from "../../webapp/src/composables/effectiveMode.js";

test("uses effective_mode when present", () => {
  assert.equal(displayModeFor({ effective_mode: "deep_thoughtful" }, "friendly"), "deep_thoughtful");
  assert.equal(displayModeFor({ effective_mode: "friendly" }, "friendly"), "friendly");
});

test("falls back to the requested mode when absent", () => {
  assert.equal(displayModeFor({ text: "hi" }, "friendly"), "friendly");
});

test("isDeepThoughtful flags only real deep_thoughtful turns", () => {
  assert.equal(isDeepThoughtful({ mode: "deep_thoughtful" }), true);
  assert.equal(isDeepThoughtful({ mode: "friendly" }), false);
});

test("resolveTranscriptTurn updates mode from the server", async () => {
  const { addTranscriptTurn, resolveTranscriptTurn } = await import("../../webapp/src/composables/useTranscript.js");
  const turn = addTranscriptTurn({ user_text: "hi", mode: "friendly", pending: true });
  resolveTranscriptTurn(turn, "reply", "deep_thoughtful");
  assert.equal(turn.mode, "deep_thoughtful");
  assert.equal(turn.pending, false);
  const t2 = addTranscriptTurn({ user_text: "hi", mode: "friendly", pending: true });
  resolveTranscriptTurn(t2, "reply");
  assert.equal(t2.mode, "friendly");
});
