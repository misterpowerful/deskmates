// Pure pairing logic for session.js's conversation-history hydration, split
// out so it's testable without a browser (session.js itself touches
// localStorage/WebSocket/crypto at import time, which node:test can't
// provide) — mirrors reconnect.js's own split of pure decision logic out of
// session.js's WebSocket plumbing.
//
// getConversationHistory (src/conversationHistory.js) returns turns as flat
// { role: "user"|"assistant", text, ts } entries, one per non-empty
// transcript/reply half of a turns.db row, in that row order (so a "user"
// entry is always immediately followed by its own "assistant" entry, sharing
// that row's ts, when the row had a reply). This re-groups that flat list
// back into one addTranscriptTurn-shaped { user_text, bot_text } object per
// original row, so replayed rows render identically to a live turn. A
// "user" entry with no following "assistant" entry (a failed turn — see
// getConversationHistory's own doc comment) becomes its own turn with
// bot_text: null.
export function pairTurnsForHydration(turns) {
  const paired = [];
  let i = 0;
  while (i < turns.length) {
    const entry = turns[i];
    if (entry.role === "user") {
      const next = turns[i + 1];
      if (next && next.role === "assistant" && next.ts === entry.ts) {
        paired.push({ user_text: entry.text, bot_text: next.text });
        i += 2;
        continue;
      }
      paired.push({ user_text: entry.text, bot_text: null });
      i += 1;
      continue;
    }
    // An "assistant" entry with no preceding "user" entry isn't produced by
    // getConversationHistory today, but is handled the same way a live
    // canned_result is: a bot-only turn rather than something dropped.
    paired.push({ user_text: null, bot_text: entry.text });
    i += 1;
  }
  return paired;
}
