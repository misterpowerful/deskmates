import { test } from "node:test";
import assert from "node:assert/strict";
import { pairTurnsForHydration } from "../../webapp/src/composables/conversationHistoryHydration.js";

test("a user entry followed by an assistant entry with a mismatched timestamp is not paired", () => {
  const turns = [
    { ts: "t1", role: "user", text: "hi" },
    { ts: "t2", role: "assistant", text: "unrelated reply from another row" },
  ];
  assert.deepEqual(pairTurnsForHydration(turns), [
    { user_text: "hi", bot_text: null },
    { user_text: null, bot_text: "unrelated reply from another row" },
  ]);
});

test("two consecutive user entries each become their own unanswered turn", () => {
  const turns = [
    { ts: "t1", role: "user", text: "first" },
    { ts: "t2", role: "user", text: "second" },
  ];
  assert.deepEqual(pairTurnsForHydration(turns), [
    { user_text: "first", bot_text: null },
    { user_text: "second", bot_text: null },
  ]);
});

test("a leading assistant entry with no preceding user entry becomes a bot-only turn", () => {
  const turns = [{ ts: "t1", role: "assistant", text: "spontaneous" }];
  assert.deepEqual(pairTurnsForHydration(turns), [{ user_text: null, bot_text: "spontaneous" }]);
});

test("an oversized turn list is paired without error", () => {
  const turns = [];
  for (let i = 0; i < 2000; i++) {
    turns.push({ ts: `t${i}`, role: "user", text: `u${i}` });
    turns.push({ ts: `t${i}`, role: "assistant", text: `a${i}` });
  }
  const paired = pairTurnsForHydration(turns);
  assert.equal(paired.length, 2000);
  assert.deepEqual(paired[0], { user_text: "u0", bot_text: "a0" });
  assert.deepEqual(paired[1999], { user_text: "u1999", bot_text: "a1999" });
});
