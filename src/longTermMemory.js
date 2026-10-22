// TODO: memory.json only grows on an explicit "remember this"-style trigger
// (never passive summarization), so it should stay small under normal use.
// After months of heavy use a batch "compact this personality's memory.json"
// pass (dedupe/merge stale facts) may eventually be worth building — not
// built yet.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.js";
import { listPersonalities } from "./config.js";
import { validateInsights, validateMemoryFacts } from "./dataValidation.js";

const ROOT = process.cwd();
const anthropic = new Anthropic();
const CONDENSE_MODEL = "claude-haiku-4-5-20251001";
const TRIGGER_MODEL = "claude-haiku-4-5-20251001";
const RECENT_TURNS_FOR_CONTEXT = 6;

// Phrases that are unambiguously a save request. Matching one is a decision,
// not a hint: the classifier is skipped entirely. This is the hot path —
// isMemoryTrigger runs on every single turn, and the classification call it
// guards is a full serial API round-trip sitting in front of the main Claude
// call, inside a pipeline whose whole latency budget is "land the real
// response before the filler line finishes playing".
const CERTAIN_TRIGGER_PHRASES = [
  "remember that",
  "remember this",
  "remember the",
  "don't forget",
  "dont forget",
  "keep in mind",
  "keep this in mind",
  "make a note",
  "note that down",
  "write that down",
];

// Weaker signals: not enough to act on, but enough to be worth asking the
// classifier about. An utterance containing none of these is treated as
// ordinary chat with no API call at all, which is the overwhelming majority
// of turns. Deliberately broad and cheap — a false positive here costs one
// small Haiku call, while a false negative silently drops a save request, so
// this errs toward asking.
const CLASSIFIER_HINTS = [
  "memor", // memory, memories, memorize
  "remember",
  "forget",
  "mind",
  "recall",
  "save",
  "store",
  "persist",
  "hold on to",
  "hold onto",
  "note",
  "keep",
];

function matchesAny(lower, phrases) {
  return phrases.some((phrase) => lower.includes(phrase));
}

// Classifies whether this utterance is asking the assistant to persist
// something to long-term memory.
//
// Three tiers, cheapest first:
//   1. A certain phrase -> true, no API call.
//   2. No hint word at all -> false, no API call. Ordinary conversation
//      exits here, so the common case costs nothing and adds no latency.
//   3. A hint but no certain phrase -> ask the classifier. This is the case
//      a fixed-phrase list alone gets wrong ("these are your memories now",
//      "hold on to that for me"), where the request would otherwise fall
//      through to normal chat and the model — unaware this gate exists —
//      could fabricate a confirmation for a save that never happened.
//
// allowClassifier: false restricts this to tiers 1 and 2 (no API call ever).
// Callers pass it for modes that can't act on a true result anyway, so those
// turns don't pay the round-trip for an answer nothing consumes.
//
// Defaults to false on any classification failure, so a transient API error
// degrades to "treat as normal chat" rather than a false positive. Note this
// means a classifier outage silently downgrades tier-3 phrasings to ordinary
// chat; tier-1 phrasings keep working regardless, which is why the certain
// list is worth keeping rather than folding everything into the model.
export async function isMemoryTrigger(transcript, { allowClassifier = true } = {}) {
  const text = (transcript ?? "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (matchesAny(lower, CERTAIN_TRIGGER_PHRASES)) return true;
  if (!allowClassifier) return false;
  if (!matchesAny(lower, CLASSIFIER_HINTS)) return false;

  try {
    const response = await anthropic.messages.create({
      model: TRIGGER_MODEL,
      max_tokens: 5,
      system:
        'You will be given a single spoken utterance directed at an assistant. Decide whether the speaker is explicitly asking the assistant to remember/save/persist something for future conversations (e.g. "remember that...", "keep this in mind", "don\'t forget...", "I want you to remember...", "these are your memories now"). Output ONLY "YES" or "NO" — nothing else.',
      messages: [{ role: "user", content: text }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    return (textBlock?.text ?? "").trim().toUpperCase().startsWith("YES");
  } catch (err) {
    log("long-term memory: trigger classification failed", {
      error: err?.message ?? String(err),
    });
    return false;
  }
}

function memoryPath(personalityName) {
  return path.join(ROOT, "personalities", personalityName, "memory.json");
}

function insightsPath(personalityName) {
  return path.join(ROOT, "personalities", personalityName, "insights.json");
}

function normalizeFact(text) {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Shared append primitive: read-modify-write personalities/<name>/memory.json.
// Used both by condenseAndStore's background fallback below and by the
// save_memory tool (src/tools/index.js) so a live tool call and the
// background condenser land facts in exactly the same shape.
//
// A missing file starts fresh, but a present-but-unparseable one is copied to
// memory.json.corrupt-<timestamp> (and logged) before continuing, so a bad
// read never silently destroys prior memories. An exact duplicate (same
// trimmed/lowercased/whitespace-collapsed text) returns the existing entry
// instead of appending. Writes go through tmp + rename so a crash mid-write
// can't truncate the file.
export function appendMemoryFact(personalityName, fact, tags = []) {
  const filePath = memoryPath(personalityName);
  let facts = [];
  let raw = null;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    let parsed;
    let ok = true;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ok = false;
    }
    if (ok && Array.isArray(parsed)) {
      facts = parsed;
    } else {
      const backup = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(filePath, backup);
      log("long-term memory: memory.json is unparseable, backed up before continuing", {
        personalityName,
        backup,
      });
    }
  }

  const key = normalizeFact(fact);
  const existing = facts.find((e) => normalizeFact(e?.fact) === key);
  if (existing) return existing;

  const entry = { fact, tags, savedAt: new Date().toISOString() };
  facts.push(entry);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(facts, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
  return entry;
}

// Strict read for scripts/reject-memory-fact.js: unlike appendMemoryFact's
// backup-and-continue leniency (this is a human-driven deletion, not a
// background write — surfacing the problem beats silently starting fresh),
// a missing file, unparseable JSON or non-array top level all throw a plain
// Error with a clear message rather than crashing with a raw stack trace.
export function readMemoryFacts(personalityName) {
  const filePath = memoryPath(personalityName);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`No memory.json for that personality: ${path.relative(ROOT, filePath)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path.relative(ROOT, filePath)} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.relative(ROOT, filePath)} is not a JSON array.`);
  }
  return parsed;
}

// Strict read for scripts/reject-insight.js and removeInsight below: same
// shape and reasoning as readMemoryFacts — a missing file, unparseable JSON
// or non-array top level all throw a plain Error with a clear message
// rather than crashing with a raw stack trace.
export function readInsights(personalityName) {
  const filePath = insightsPath(personalityName);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`No insights.json for that personality: ${path.relative(ROOT, filePath)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path.relative(ROOT, filePath)} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.relative(ROOT, filePath)} is not a JSON array.`);
  }
  return parsed;
}

// Deletes the insight at `index` from personalityName's insights.json: same
// re-read-fresh / splice / validate / tmp+rename shape as removeMemoryFact,
// shared by scripts/reject-insight.js's CLI and server.js's
// /api/memory/insight endpoint so neither duplicates the splice/validate/
// write logic. Returns the removed entry.
export function removeInsight(personalityName, index) {
  const filePath = insightsPath(personalityName);
  const insights = readInsights(personalityName);
  if (!Number.isInteger(index) || index < 0 || index >= insights.length) {
    throw new Error(`Index ${index} out of range — ${personalityName} has ${insights.length} insight(s).`);
  }

  const [removed] = insights.splice(index, 1);
  const check = validateInsights(insights);
  if (!check.ok) {
    throw new Error(`Refusing to write invalid insights.json: ${check.errors.join("; ")}`);
  }

  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(insights, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
  return removed;
}

// Deletes the fact at `index` from personalityName's memory.json: re-reads
// the file fresh (readMemoryFacts), splices, validates the resulting array
// (validateMemoryFacts) and refuses to write if that fails, then writes via
// the same tmp + rename pattern as appendMemoryFact so a crash mid-write
// can't truncate the file. Returns the removed entry.
export function removeMemoryFact(personalityName, index) {
  const filePath = memoryPath(personalityName);
  const facts = readMemoryFacts(personalityName);
  if (!Number.isInteger(index) || index < 0 || index >= facts.length) {
    throw new Error(`Index ${index} out of range — ${personalityName} has ${facts.length} fact(s).`);
  }

  const [removed] = facts.splice(index, 1);
  const check = validateMemoryFacts(facts);
  if (!check.ok) {
    throw new Error(`Refusing to write invalid memory.json: ${check.errors.join("; ")}`);
  }

  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(facts, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
  return removed;
}

// Reads personalities/<personalityName>/memory.json and formats it as a
// distinct system-prompt block. Returns "" (never a block with an empty
// list) when the file is missing, unreadable, or an empty array, so the
// caller can just omit it entirely.
export function getLongTermMemoryBlock(personalityName) {
  let facts;
  try {
    facts = JSON.parse(fs.readFileSync(memoryPath(personalityName), "utf8"));
  } catch {
    return "";
  }
  if (!Array.isArray(facts) || facts.length === 0) return "";

  const lines = facts.map((entry) => `- ${entry.fact}`).join("\n");
  return `LONG-TERM MEMORY (things you've been asked to remember):\n${lines}`;
}

// Fallback path only, used when a memory-trigger turn lands in a mode with
// no tool access (see TOOL_ENABLED_MODES in speechPipeline.js — e.g.
// sentry_intruder, bump_complaint), so there's no live save_memory tool call
// available for the model to decide with. In tool-enabled modes the model
// calls save_memory itself instead, with its own wording — this function
// never runs there. Fire-and-forget: builds a short transcript from recent
// session turns plus the just-said trigger utterance, asks Claude to
// condense it to one fact, and appends that fact to this personality's
// memory.json. Never throws — any failure anywhere in this chain is logged
// and swallowed, since the spoken acknowledgment to the bot has already
// gone out by the time this runs and a background failure here must stay
// invisible to the user.
export async function condenseAndStore(personalityName, sessionTurns, transcript) {
  try {
    const recent = sessionTurns.slice(-RECENT_TURNS_FOR_CONTEXT);
    const snippet = [...recent, { role: "user", content: transcript }]
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n");

    const response = await anthropic.messages.create({
      model: CONDENSE_MODEL,
      max_tokens: 150,
      system:
        'You will be given a snippet of conversation. Output ONLY a JSON object of the exact shape {"fact": string, "tags": string[]} — `fact` is a single short factual sentence, 20 words or fewer, capturing the specific thing that should be remembered; `tags` is 1 to 3 short lowercase freeform words categorizing it (e.g. ["music", "preferences"]). No preamble, no markdown code fences, no explanation — output nothing but the JSON object itself.',
      messages: [{ role: "user", content: snippet }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const raw = (textBlock?.text ?? "").trim();

    // The model is asked for JSON but nothing here depends on it complying —
    // a malformed/unparseable response degrades to the pre-tagging behavior
    // (the raw text becomes the fact, tags come back empty) rather than
    // dropping the save entirely.
    let fact = "";
    let tags = [];
    try {
      const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed.fact === "string") {
        fact = parsed.fact.trim();
        if (Array.isArray(parsed.tags)) {
          tags = parsed.tags
            .filter((t) => typeof t === "string" && t.trim())
            .map((t) => t.trim().toLowerCase());
        }
      } else {
        fact = raw;
      }
    } catch {
      fact = raw;
    }

    if (!fact) {
      log("long-term memory: condensation produced no fact, skipping write", {
        personalityName,
      });
      return;
    }

    const saved = appendMemoryFact(personalityName, fact, tags);
    log("long-term memory: fact saved", { personalityName, fact: saved.fact, tags: saved.tags });
  } catch (err) {
    log("long-term memory: condensation/store failed", {
      personalityName,
      error: err?.message ?? String(err),
    });
  }
}

function readJsonArraySafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Newest first, pairing each entry with its position in the on-disk array
// before sorting. getMemorySnapshot's output is itself sorted (newest
// first), so without this the index a client sends back to delete an entry
// (removeMemoryFact/removeInsight both index into the *unsorted* file)
// would silently target the wrong one. Entries with a missing/unparseable
// date key sort last (treated as epoch 0) rather than throwing or floating
// to the top.
function indexAndSortByDateDesc(list, dateKey) {
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ta = Date.parse(a.entry?.[dateKey]);
      const tb = Date.parse(b.entry?.[dateKey]);
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });
}

export class UnknownPersonalityError extends Error {}

// Read-only snapshot of a personality's long-term-memory facts
// (memory.json) and self-reflection insights (insights.json), for the
// console/webapp Memory panel (server.js's /api/memory). Insights are
// auto-approved on write by scripts/run-reflection.js with no human gate —
// this snapshot is how a bad one (or an unwanted fact) gets noticed in the
// first place. Each entry carries its position in the on-disk array as
// `index` (not its position in this newest-first-sorted output) so the
// panel's delete action can hand that straight to removeMemoryFact /
// removeInsight (via server.js's /api/memory/fact and /api/memory/insight)
// without the client having to reconstruct file order itself.
//
// Reachable end-to-end from an HTTP query param, so every field is
// defensively normalized rather than trusted as-is: a malformed file
// degrades to an empty list (same rule getLongTermMemoryBlock already
// follows) and a malformed individual entry degrades field-by-field
// instead of the whole snapshot failing.
export function getMemorySnapshot(personalityName) {
  const known = listPersonalities();
  if (!known.includes(personalityName)) {
    throw new UnknownPersonalityError(
      `unknown personality "${personalityName}" (known: ${known.join(", ")})`,
    );
  }

  const facts = indexAndSortByDateDesc(readJsonArraySafe(memoryPath(personalityName)), "savedAt").map(
    ({ entry, index }) => ({
      index,
      fact: typeof entry?.fact === "string" ? entry.fact : "",
      tags: Array.isArray(entry?.tags) ? entry.tags.filter((t) => typeof t === "string") : [],
      savedAt: typeof entry?.savedAt === "string" ? entry.savedAt : null,
    }),
  );

  const insights = indexAndSortByDateDesc(readJsonArraySafe(insightsPath(personalityName)), "createdAt").map(
    ({ entry, index }) => ({
      index,
      insight: typeof entry?.insight === "string" ? entry.insight : "",
      sourceTags: Array.isArray(entry?.sourceTags)
        ? entry.sourceTags.filter((t) => typeof t === "string")
        : [],
      createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : null,
      status: typeof entry?.status === "string" ? entry.status : "",
    }),
  );

  return { facts, insights };
}
