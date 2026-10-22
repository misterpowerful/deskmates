import { log } from "./logger.js";

export const DEEP_THOUGHTFUL_TRIGGERS = [
  "think about this",
  "really think about",
  "think it through",
  "think it over",
  "give it some thought",
  "thoughtful answer",
  "think thoughtfully",
  "thoughtfully about",
  "think deeply",
  "thinking deeply",
  "deep thought",
  "deep thinking",
  "think hard",
  "think carefully",
  "consider carefully",
  // Bare "thoughtful" / bare "deeply" / bare "think" are deliberately left
  // out — matched as a substring against the whole transcript, they fire
  // on unrelated sentences that merely contain the word (e.g. an
  // instruction about switching to "thoughtful" mode itself, or "I deeply
  // appreciate that"), not just genuine requests to think something
  // through. Every entry above is a multi-word phrase specific enough to
  // reflect actual intent to invoke this mode.
  // "Look it up" / "research" / "find out" are deliberately NOT here
  // (2026-10-13): the friendly path already has web search, answering in a
  // few seconds, where this mode's Claude Code research took 20-25 s - long
  // enough for the bot to give up. Ask to think hard to get this mode.
  // Self-improvement: a request for a new idea, or a follow-up asking about
  // ideas already given (both need this mode — see getSelfProposalsBlock
  // and the propose_task machinery below). Same substring-match tradeoff as
  // above: specific enough to skip bare "improve", loose enough to catch
  // the obvious phrasings.
  "how could you improve",
  "how could you be better",
  "suggest something new",
  "suggest an improvement",
  "what would make you better",
  "improve yourself",
  "what have you proposed",
  "what have you suggested",
  "you proposed",
  "you suggested",
];

// Checked only while a connection's deepThoughtfulSticky flag is already
// true (see resolveEffectiveMode) — an explicit way out of the sticky
// session besides just closing the connection. Same substring-match
// discipline as DEEP_THOUGHTFUL_TRIGGERS: specific multi-word phrases only,
// no bare words like "normal" or "stop" that could fire on an unrelated
// sentence.
export const DEEP_THOUGHTFUL_EXIT_TRIGGERS = [
  "back to normal",
  "normal mode",
  "regular conversation",
  "stop thinking about this",
  "exit thoughtful mode",
  "that's enough thinking",
  "go back to normal",
];

// How many turns a phrase-triggered deep_thoughtful session lasts before it
// drops back to ordinary friendly on its own. Counts the triggering turn
// itself, so 3 == the trigger turn plus two follow-ups. Previously sticky
// mode lasted the whole connection and only ended on an explicit exit
// phrase, which meant one trigger phrase early in a session silently ran
// every later turn on the deep_thoughtful model (Sonnet, 4096 max_tokens,
// tool-enabled) instead of the default (Haiku, 1024). The explicit exit
// triggers still work and still end it early.
export const DEEP_THOUGHTFUL_STICKY_TURNS = 3;

// Typed escape hatch for the text path (webapp/console): a message starting
// with "dt:" runs that ONE turn in deep_thoughtful and does not engage
// stickiness. Deliberately one-shot rather than sticky — when the request is
// explicit per-message there's no guessing to do, so the expensive mode is
// only ever paid for on the messages actually marked for it. The prefix is
// stripped before the transcript reaches Claude, session memory, or the
// memory-trigger check, so it never leaks into what the model sees.
const DEEP_THOUGHTFUL_PREFIX = /^\s*dt\s*:\s*/i;

// Returns the transcript with any "dt:" prefix removed, plus whether it was
// present. An empty remainder (a bare "dt:") is treated as not-a-prefix so
// the turn still carries its original text rather than becoming an empty
// message.
export function stripDeepThoughtfulPrefix(transcript) {
  const match = DEEP_THOUGHTFUL_PREFIX.exec(transcript);
  if (!match) return { transcript, forced: false };
  const stripped = transcript.slice(match[0].length).trim();
  if (!stripped) return { transcript, forced: false };
  return { transcript: stripped, forced: true };
}

export function isDeepThoughtfulTrigger(transcript) {
  const lower = transcript.toLowerCase();
  return DEEP_THOUGHTFUL_TRIGGERS.some((phrase) => lower.includes(phrase));
}

export function isDeepThoughtfulExitTrigger(transcript) {
  const lower = transcript.toLowerCase();
  return DEEP_THOUGHTFUL_EXIT_TRIGGERS.some((phrase) => lower.includes(phrase));
}

// Sticky for the rest of the connection's lifetime once triggered, not
// one-shot-per-turn: connection.deepThoughtfulSticky lives directly on the
// WebSocket connection object, same pattern as connection.sessionMemory in
// sessionMemory.js, so it's scoped to that connection and needs no cleanup
// beyond the socket closing.
//
// Security-relevant gate, unchanged: this only ever applies when the bot
// itself sends mode "friendly" — an unrecognized person under
// sentry_intruder cannot talk (or stay talked) into deep_thoughtful. A
// non-friendly turn returns `mode` as-is and leaves the sticky flag
// untouched either way, so if the bot reports "friendly" again on a later
// turn (the owner is back in frame), a still-sticky session resumes
// without needing to re-trigger.
//
// Ordering while friendly:
//   0. "dt:" prefix (text path) -> this turn only, stickiness untouched.
//   1. sticky + exit phrase this turn -> clear sticky, this turn is NOT
//      deep_thoughtful (the exit request itself gets an ordinary reply).
//   2. sticky, budget remaining -> stay in deep_thoughtful, no fresh trigger
//      phrase needed; budget decrements.
//   3. sticky, budget exhausted -> clear sticky, this turn is ordinary.
//   4. not sticky -> fall back to the original one-shot trigger check,
//      engaging stickiness (with a fresh budget) from here on if it matches.
//
// `forced` is the "dt:" prefix result and is checked before everything else:
// an explicitly marked message is deep_thoughtful regardless of sticky
// state, and does not extend or start a sticky run.
export function resolveEffectiveMode(connection, mode, transcript, forced = false) {
  if (mode !== "friendly") {
    return mode;
  }

  if (forced) {
    connection.deepThoughtfulReason = "dt_prefix";
    log("deep_thoughtful: engaged for one turn via dt: prefix", { transcript });
    return "deep_thoughtful";
  }

  if (connection.deepThoughtfulSticky) {
    if (isDeepThoughtfulExitTrigger(transcript)) {
      connection.deepThoughtfulSticky = false;
      connection.deepThoughtfulTurnsRemaining = 0;
      connection.deepThoughtfulReason = null;
      log("deep_thoughtful: sticky mode exited (explicit)", { transcript });
      return mode;
    }

    if ((connection.deepThoughtfulTurnsRemaining ?? 0) <= 0) {
      connection.deepThoughtfulSticky = false;
      connection.deepThoughtfulReason = null;
      log("deep_thoughtful: sticky mode expired (turn budget reached)", {
        transcript,
        turns: DEEP_THOUGHTFUL_STICKY_TURNS,
      });
      return mode;
    }

    connection.deepThoughtfulTurnsRemaining -= 1;
    connection.deepThoughtfulReason = "sticky_carryover";
    return "deep_thoughtful";
  }

  connection.deepThoughtfulReason = null;

  if (isDeepThoughtfulTrigger(transcript)) {
    connection.deepThoughtfulSticky = true;
    // The triggering turn is the first of the budget.
    connection.deepThoughtfulTurnsRemaining = DEEP_THOUGHTFUL_STICKY_TURNS - 1;
    connection.deepThoughtfulReason = "phrase_trigger";
    log("deep_thoughtful: sticky mode engaged", {
      transcript,
      turns: DEEP_THOUGHTFUL_STICKY_TURNS,
    });
    return "deep_thoughtful";
  }

  return mode;
}

// deep_thoughtful-only: switches that call's Claude response from a bare
// spoken line to the { reply, propose_task } JSON shape parsed by
// parseDeepThoughtfulOutput below. Kept as its own block, appended last, so
// every other mode's prompt and behavior is completely unaffected.
// propose_task is for the bot's own ideas only; a task the person explicitly
// asks it to queue goes through the queue_task tool instead (src/tools/index.js).
export const SELF_PROPOSAL_OUTPUT_FORMAT = `RESPONSE FORMAT (this turn only): reply with ONLY a JSON object — no markdown code fence, no text before or after it — of the exact shape:
{"reply": "<exactly what you'd say out loud, same as any other turn>", "propose_task": {"title": "<short title>", "description": "<what to build/fix and why, written for whoever builds it later>"} | null}

Rules for propose_task:
- null unless the person's message THIS TURN explicitly asked you for a suggestion, idea, or way you could improve — never populate it unprompted, and never more than one idea per reply.
- Must be genuinely new: check it against YOUR PAST SELF-PROPOSALS and WHAT YOU CAN DO above. If you can't think of a concrete idea that isn't already built or already proposed, set it to null and say so in "reply" instead of forcing one.
- If the person instead asks you to add, queue, or put a task THEY described on the build queue, call the queue_task tool for it and leave propose_task null — never put their task in propose_task.
- "description" is for the engineer who builds it later, not spoken aloud — never let its content leak into "reply".
- A change to your own personality or voice needs a real reason: quote, in double quotes, what the owner actually said that prompted it, and keep the step small. Without a genuine quote the build rejects it.`;

// Falls back to treating the whole raw response as the spoken reply, with
// no proposal, if the model doesn't comply with the JSON shape — same
// graceful-degradation pattern as condenseAndStore's fact parsing, so a
// malformed response degrades to "just say the words" rather than the bot
// speaking raw JSON or the turn throwing.
export function parseDeepThoughtfulOutput(raw) {
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed.reply === "string") {
      const t = parsed.propose_task;
      const proposeTask =
        t &&
        typeof t.title === "string" &&
        t.title.trim() &&
        typeof t.description === "string" &&
        t.description.trim()
          ? { title: t.title.trim(), description: t.description.trim() }
          : null;
      return { reply: parsed.reply.trim(), proposeTask };
    }
  } catch {
    // Falls through to the recovery attempt below.
  }
  // Full JSON parse failed — unlike condenseAndStore's fallback (never
  // spoken, just stored), "reply" here goes straight to TTS, so falling
  // back to the raw text would risk speaking literal JSON syntax aloud on
  // a near-miss (one stray character, an unescaped quote). Try to recover
  // just the "reply" string value via regex first; only truly bail to raw
  // if that also fails.
  const match = raw.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (match) {
    try {
      return { reply: JSON.parse(`"${match[1]}"`), proposeTask: null };
    } catch {
      // fall through to raw below
    }
  }
  return { reply: raw, proposeTask: null };
}
