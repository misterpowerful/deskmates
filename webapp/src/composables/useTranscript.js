import { reactive } from "vue";

const MAX_TURNS = 750;

// { timestamp, user_text, bot_text, mode, personality, is_filler, pending }
export const transcript = reactive([]);

// Returns the pushed turn — read back through the reactive array rather than
// the plain object literal above, so later mutations (see resolveTranscriptTurn)
// go through Vue's proxy and actually trigger UI updates.
export function addTranscriptTurn({ user_text = null, bot_text = null, mode, personality, is_filler = false, pending = false }) {
  transcript.push({
    timestamp: new Date().toISOString(),
    user_text,
    bot_text,
    mode,
    personality,
    is_filler,
    pending,
  });
  if (transcript.length > MAX_TURNS) {
    transcript.splice(0, transcript.length - MAX_TURNS);
  }
  return transcript[transcript.length - 1];
}

// Fills in the bot's line on a turn added earlier via addTranscriptTurn with
// pending:true (the text_request "typing…" placeholder) — mutates in place
// so the row updates without reshuffling the transcript.
export function resolveTranscriptTurn(turn, bot_text, mode) {
  turn.bot_text = bot_text;
  if (mode) turn.mode = mode;
  turn.pending = false;
}

export function clearTranscript() {
  transcript.splice(0, transcript.length);
}

// slug -> display name, learned from the server as messages carrying one
// arrive (personalities_result's display_names map, and speech_result/
// text_result's own personality_display_name — see session.js). Module-level
// rather than persisted anywhere, so a fresh connection repopulates it before
// any turn needs it (list_personalities is sent right after connect).
const knownDisplayNames = new Map();

export function registerPersonalityDisplayName(slug, displayName) {
  if (!slug || typeof displayName !== "string" || !displayName.trim()) return;
  knownDisplayNames.set(slug, displayName.trim());
}

// "gatsby-sardonic" -> "Gatsby", "chet" -> "Chet". Prefers the server-sourced
// display_name (registered above) when one has been seen for this slug; only
// falls back to deriving a name from the slug itself — split on the first
// "-", capitalize it — for old data or a server that hasn't sent one yet.
// That fallback happens to produce the right result for today's three
// personalities, but it's a coincidence of naming, not a real name.
export function personalityDisplayName(slug) {
  if (!slug) return "BOT";
  const known = knownDisplayNames.get(slug);
  if (known) return known;
  const first = slug.split("-")[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function formatTranscriptForCopy() {
  const lines = [];
  for (const turn of transcript) {
    const t = new Date(turn.timestamp).toLocaleTimeString();
    if (turn.user_text) {
      lines.push(`[${t}] YOU: ${turn.user_text}`);
    }
    const name = personalityDisplayName(turn.personality).toUpperCase();
    const tag = turn.is_filler ? "filler" : turn.mode;
    const label = tag ? `${name} (${tag})` : name;
    const line = turn.pending ? "(pending…)" : turn.bot_text ?? "(no transcript line for this turn)";
    lines.push(`[${t}] ${label}: ${line}`);
  }
  return lines.join("\n");
}
