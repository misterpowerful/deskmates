import fs from "node:fs";
import path from "node:path";

// Categories requested by name that have no entry in data/phrase-manifest.json
// (server.js pipeline_error fallback, speechPipeline.js memory-saved ack,
// and the filler/greeting/question_filler lines clients ask for).
export const MANIFEST_FREE_CATEGORIES = [
  "filler",
  "greeting",
  "question_filler",
  "custom-memory_saved",
  "pipeline_error",
];

export const PERSONALITY_FILES = ["personality-breakdown.md", "voice-config.json"];

export function expectedCategories(root = process.cwd()) {
  let manifestKeys = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "phrase-manifest.json"), "utf8"));
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      manifestKeys = Object.keys(manifest);
    }
  } catch {
    // no/invalid manifest: only the manifest-free categories are expected
  }
  return [...new Set([...manifestKeys, ...MANIFEST_FREE_CATEGORIES])].sort();
}

function countLines(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

// Same lookup rule as resolveBucket: a category is covered when any mode dir
// or shared/ under canned-responses holds at least one non-dotfile.
export function personalityCoverage(name, root = process.cwd()) {
  const personalityDir = path.join(root, "personalities", name);
  const cannedDir = path.join(personalityDir, "canned-responses");
  let buckets = [];
  try {
    buckets = fs.readdirSync(cannedDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // no canned-responses directory
  }
  const expected = expectedCategories(root);
  const categories = {};
  for (const category of expected) {
    categories[category] = buckets.reduce((n, b) => n + countLines(path.join(cannedDir, b, category)), 0);
  }
  const missing = expected.filter((c) => categories[c] === 0);
  const files = {};
  for (const f of PERSONALITY_FILES) files[f] = fs.existsSync(path.join(personalityDir, f));
  return {
    name,
    categoriesExpected: expected.length,
    categoriesCovered: expected.length - missing.length,
    categories,
    missing,
    files,
    // null when voice-config.json has no (valid, non-blank) display_name yet.
    displayName: readDisplayName(name, root),
  };
}

export function coverageSummary(name, root = process.cwd()) {
  const { categoriesCovered, categoriesExpected } = personalityCoverage(name, root);
  return { categoriesCovered, categoriesExpected };
}

function readVoiceConfig(name, root) {
  try {
    const raw = fs.readFileSync(path.join(root, "personalities", name, "voice-config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The authoritative display_name from voice-config.json, or null when the
// personality has none set yet (missing file, malformed JSON, no key, or a
// non-string/blank value all count as "not set" rather than throwing or
// silently accepting garbage) — callers that need a gap flagged (like
// runCoverageCheck below) want this null, not a guessed fallback.
export function readDisplayName(name, root = process.cwd()) {
  const raw = readVoiceConfig(name, root)?.display_name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

// Mirrors webapp/src/composables/useTranscript.js's personalityDisplayName()
// slug fallback exactly (split on the first "-", capitalize it) — used only
// when a personality genuinely has no display_name set.
export function deriveDisplayNameFromSlug(name) {
  if (!name || typeof name !== "string") return "BOT";
  const first = name.split("-")[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "BOT";
}

// The name wire messages (list_personalities, speech/text turn results) hand
// clients — always a non-empty string, so clients never need to derive
// anything themselves for a personality the server actually knows about.
export function getPersonalityDisplayName(name, root = process.cwd()) {
  return readDisplayName(name, root) ?? deriveDisplayNameFromSlug(name);
}

export const MAX_DISPLAY_NAME_LENGTH = 60;

// Rewrites display_name into <name>/voice-config.json, preserving every
// other key already in the file (voice_id, model, ...). Written via
// tmp-file + renameSync — same crash-safety pattern as queueOrder.js and
// turnLog.js — since a truncated voice-config.json would break every future
// read (personality coverage checks, turn results, list_personalities),
// not just this one field. Throws on a blank/oversized name or a
// personality with no existing voice-config.json to update, since a call
// site is expected to have already validated the personality itself exists
// (see setActivePersonality's validate-then-write style in config.js).
export function setPersonalityDisplayName(name, displayName, root = process.cwd()) {
  const trimmed = typeof displayName === "string" ? displayName.trim() : "";
  if (!trimmed) throw new Error("display_name must be a non-empty string");
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`display_name is too long (max ${MAX_DISPLAY_NAME_LENGTH} characters)`);
  }
  const file = path.join(root, "personalities", name, "voice-config.json");
  const config = readVoiceConfig(name, root);
  if (!config) throw new Error(`cannot read voice-config.json for "${name}"`);
  config.display_name = trimmed;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return trimmed;
}

// One-line, ready-to-log warning for whichever personality is currently
// active (at server startup, or right after a live set_personality switch)
// — reuses personalityCoverage's category gap so a half-built personality
// (e.g. no canned-responses/ dir at all, like "reggie"/"fergal", or only one
// populated category, like "chet") is visible in the server logs immediately
// rather than only discoverable by manually running npm run check-personality
// or noticing every canned line fail at runtime (getCannedResponse's
// { ok: false } path, including the pipeline_error fallback in server.js).
// Returns null when every expected category is covered, so callers can skip
// logging anything for a personality with no gap.
export function coverageWarning(name, root = process.cwd()) {
  const cov = personalityCoverage(name, root);
  if (!cov.missing.length) return null;
  return (
    `active personality "${name}" has incomplete canned-response coverage ` +
    `(${cov.categoriesCovered}/${cov.categoriesExpected} categories covered) — missing: ${cov.missing.join(", ")}`
  );
}

// Returns { output, exitCode }. Exits 1 when the active personality has a gap
// or a requested name is unknown.
export function runCoverageCheck({ names, all, active, root = process.cwd() }) {
  const out = [];
  let exitCode = 0;
  const targets = names && names.length ? names : all;
  for (const name of targets) {
    if (!all.includes(name)) {
      out.push(`${name}: unknown personality (known: ${all.join(", ")})`);
      exitCode = 1;
      continue;
    }
    const cov = personalityCoverage(name, root);
    const isActive = name === active;
    out.push(`${name}${isActive ? " (active)" : ""}: ${cov.categoriesCovered}/${cov.categoriesExpected} categories covered`);
    if (cov.missing.length) out.push(`  missing: ${cov.missing.join(", ")}`);
    for (const f of PERSONALITY_FILES) out.push(`  ${f}: ${cov.files[f] ? "present" : "MISSING"}`);
    out.push(`  display_name: ${cov.displayName ? `"${cov.displayName}"` : "MISSING"}`);
    if (isActive && (cov.missing.length || !cov.displayName)) exitCode = 1;
  }
  return { output: out.join("\n"), exitCode };
}
