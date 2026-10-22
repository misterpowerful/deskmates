// Guard for overnight builds that change a personality's character or voice
// (personality-breakdown.md, voice-config.json). The owner, 2026-10-17: Gatsby
// may propose personality changes, but only with a real reason, and in
// small steps. A build that touches those files must quote the owner's actual
// words (checked against the turn log), and voice speed may only move a
// little per task. "Slow down, you're too fast" once became 1.15 -> 0.85.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const GUARDED_FILE = /^personalities\/[^/]+\/(personality-breakdown\.md|voice-config\.json)$/;
export const MAX_SPEED_STEP = 0.1;
export const MIN_SPEED = 0.9;
export const MAX_SPEED = 1.2;
const MIN_QUOTE_CHARS = 12;
const TRANSCRIPT_DAYS = 30;

export function guardedFiles(changedFiles) {
  return changedFiles.filter((f) => GUARDED_FILE.test(f));
}

// Quoted passages ("...", or curly quotes) long enough to be real evidence.
export function extractQuotes(text) {
  const quotes = [];
  for (const m of String(text ?? "").matchAll(/["“]([^"“”]+)["”]/g)) {
    if (m[1].trim().length >= MIN_QUOTE_CHARS) quotes.push(m[1].trim());
  }
  return quotes;
}

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True if the quote appears (ignoring case and punctuation) in something
// The owner actually said.
export function quoteIsGenuine(quote, transcripts) {
  const q = normalize(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return transcripts.some((t) => normalize(t).includes(q));
}

export function loadRecentTranscripts(dbPath, { now = Date.now(), days = TRANSCRIPT_DAYS } = {}) {
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const since = new Date(now - days * 86400_000).toISOString();
    return db
      .prepare("SELECT transcript FROM turns WHERE ts >= ? AND transcript IS NOT NULL")
      .all(since)
      .map((r) => r.transcript);
  } finally {
    db.close();
  }
}

// Speed problems between two voice-config.json texts: each mode may move by
// at most MAX_SPEED_STEP and must stay within MIN_SPEED..MAX_SPEED.
export function speedProblems(beforeText, afterText) {
  const speedsOf = (text) => {
    try {
      const speed = JSON.parse(text)?.speed;
      return speed && typeof speed === "object" ? speed : {};
    } catch {
      return null;
    }
  };
  const before = speedsOf(beforeText) ?? {};
  const after = speedsOf(afterText);
  if (after === null) return ["voice-config.json is not valid JSON"];
  const problems = [];
  for (const [mode, value] of Object.entries(after)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`speed.${mode} is not a number`);
      continue;
    }
    if (value < MIN_SPEED || value > MAX_SPEED) {
      problems.push(`speed.${mode} = ${value} is outside ${MIN_SPEED}-${MAX_SPEED}`);
    }
    const old = before[mode];
    if (typeof old === "number" && Math.abs(value - old) > MAX_SPEED_STEP + 1e-9) {
      problems.push(`speed.${mode} moved ${old} -> ${value}, more than ${MAX_SPEED_STEP} in one step`);
    }
  }
  return problems;
}

// { ok, problems } for a build's changes. readBefore/readAfter(file) return
// the file's text before and after the change ("" if it didn't exist).
export function checkPersonalityChange({ changedFiles, taskText, transcripts, readBefore, readAfter }) {
  const touched = guardedFiles(changedFiles);
  if (touched.length === 0) return { ok: true, problems: [] };
  const problems = [];
  const quotes = extractQuotes(taskText);
  if (!quotes.some((q) => quoteIsGenuine(q, transcripts))) {
    problems.push(
      `changes ${touched.join(", ")} but the task doesn't quote anything the owner actually said asking for it`,
    );
  }
  for (const file of touched.filter((f) => f.endsWith("voice-config.json"))) {
    problems.push(...speedProblems(readBefore(file), readAfter(file)));
  }
  return { ok: problems.length === 0, problems };
}
