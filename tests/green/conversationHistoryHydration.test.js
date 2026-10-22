import { test } from "node:test";
import assert from "node:assert/strict";
import { pairTurnsForHydration } from "../../webapp/src/composables/conversationHistoryHydration.js";

test("pairs a user/assistant entry sharing a timestamp into one turn", () => {
  const turns = [
    { ts: "t1", role: "user", text: "hi" },
    { ts: "t1", role: "assistant", text: "hello" },
    { ts: "t2", role: "user", text: "bye" },
    { ts: "t2", role: "assistant", text: "goodbye" },
  ];
  assert.deepEqual(pairTurnsForHydration(turns), [
    { user_text: "hi", bot_text: "hello" },
    { user_text: "bye", bot_text: "goodbye" },
  ]);
});

test("a user entry with no following assistant entry becomes its own turn with bot_text: null", () => {
  const turns = [
    { ts: "t1", role: "user", text: "first" },
    { ts: "t1", role: "assistant", text: "reply" },
    { ts: "t2", role: "user", text: "unanswered" },
  ];
  assert.deepEqual(pairTurnsForHydration(turns), [
    { user_text: "first", bot_text: "reply" },
    { user_text: "unanswered", bot_text: null },
  ]);
});

test("an empty turn list pairs into an empty list", () => {
  assert.deepEqual(pairTurnsForHydration([]), []);
});
