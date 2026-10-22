import fs from "node:fs";
import path from "node:path";
import { readConfig } from "./config.js";

export const SELF_IMPROVE_SECTION_HEADING = "## Self-improvement pipeline";

// Personality prompt + voice, cached per personality name and re-read only
// when either file's mtime changes (a stat instead of two reads + a parse).
const personalityCache = new Map();

export function loadPersonality(config, root = process.cwd()) {
  const { active_personality } = config;
  const base = path.join(root, "personalities", active_personality);
  const promptFile = path.join(base, "personality-breakdown.md");
  const voiceFile = path.join(base, "voice-config.json");
  const sig = `${fileSignature(promptFile)}|${fileSignature(voiceFile)}`;
  const key = `${root}\0${active_personality}`;
  const hit = personalityCache.get(key);
  if (hit?.sig === sig) return hit.value;
  const systemPrompt = fs.readFileSync(promptFile, "utf8");
  const { voice_id, model, speed } = JSON.parse(fs.readFileSync(voiceFile, "utf8"));
  const value = { activePersonality: active_personality, systemPrompt, voice_id, model, speed };
  personalityCache.set(key, { sig, value });
  return value;
}

// voice-config.json's "speed" is a per-mode map (e.g. {friendly: 1.15,
// sentry_intruder: 1.0}) and isn't guaranteed to cover every mode — reggie
// and fergal's only define friendly/sentry_intruder. Falls back to the
// "friendly" entry, then 1.0, rather than ever handing ElevenLabs an
// undefined/non-numeric speed.
export function resolveVoiceSpeed(speed, mode) {
  if (speed && typeof speed === "object" && typeof speed[mode] === "number") {
    return speed[mode];
  }
  if (speed && typeof speed === "object" && typeof speed.friendly === "number") {
    return speed.friendly;
  }
  return 1.0;
}

function fileSignature(file) {
  try {
    return String(fs.statSync(file).mtimeMs);
  } catch {
    return "missing";
  }
}

// A cut-down truncation of CAPABILITIES.md, same rule as before the cache:
// an unapproved personality gets the file with the self-improvement section
// (deliberately last) removed entirely.
function buildCapabilitiesBlock(file, selfImproveApproved) {
  try {
    let content = fs.readFileSync(file, "utf8");
    if (!selfImproveApproved) {
      const idx = content.indexOf(SELF_IMPROVE_SECTION_HEADING);
      if (idx !== -1) content = content.slice(0, idx).trimEnd() + "\n";
    }
    return `WHAT YOU CAN DO (for accurately answering "what can you do?"-style questions):\n${content}`;
  } catch {
    return "";
  }
}

function buildInsightsBlock(file) {
  let insights;
  try {
    insights = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
  if (!Array.isArray(insights)) return "";

  const approved = insights.filter((entry) => entry?.status === "approved");
  if (approved.length === 0) return "";

  const lines = approved.map((entry) => `- ${entry.insight}`).join("\n");
  return `REFLECTIONS (patterns noticed across long-term memory, approved for use):\n${lines}`;
}

// Memoizes the static deep_thoughtful prompt blocks per personality. The
// whole cache is dropped when the active personality changes; each entry is
// also stat-validated against its source file's mtime, so an edited
// CAPABILITIES.md or a newly approved insight still shows up live (a stat
// instead of a read + parse) — output stays identical to an uncached build.
export function createStaticBlockCache({ root = process.cwd(), capabilitiesPath } = {}) {
  const capsFile = capabilitiesPath ?? path.join(root, "CAPABILITIES.md");
  let lastPersonality;
  let entries = new Map();

  function memo(personality, key, file, build) {
    if (personality !== lastPersonality) {
      entries = new Map();
      lastPersonality = personality;
    }
    const sig = fileSignature(file);
    const hit = entries.get(key);
    if (hit && hit.sig === sig) return hit.value;
    const value = build();
    entries.set(key, { sig, value });
    return value;
  }

  return {
    capabilitiesBlock(personality, selfImproveApproved) {
      const approved = Boolean(selfImproveApproved);
      return memo(personality, `caps:${approved}`, capsFile, () =>
        buildCapabilitiesBlock(capsFile, approved),
      );
    },
    insightsBlock(personality) {
      const file = path.join(root, "personalities", String(personality), "insights.json");
      return memo(personality, "insights", file, () => buildInsightsBlock(file));
    },
    size: () => entries.size,
  };
}

// Process-wide instance backing the speech pipeline's prompt assembly.
const sharedBlocks = createStaticBlockCache();

export function loadActivePersonality() {
  return loadPersonality(readConfig());
}

export function getCapabilitiesBlock(selfImproveApproved) {
  return sharedBlocks.capabilitiesBlock(readConfig().active_personality, selfImproveApproved);
}

export function getApprovedInsightsBlock(personalityName) {
  return sharedBlocks.insightsBlock(personalityName);
}
