import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "config.json");
const PERSONALITIES_DIR = path.join(process.cwd(), "personalities");

let cached;

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// config.json must be picked up live with no server restart, so every call
// stats the file — but it is only re-read and re-parsed when its mtime/size
// changed, which turns the several per-turn calls into cheap stats. The
// returned object is frozen because it is shared between callers.
export function readConfig() {
  const { mtimeMs, size } = fs.statSync(CONFIG_PATH);
  if (cached?.mtimeMs !== mtimeMs || cached.size !== size) {
    const value = deepFreeze(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
    cached = { mtimeMs, size, value };
  }
  return cached.value;
}

// Conversation models the operator can switch between at runtime (config.json
// "active_llm", flipped live from the console/webapp like active_personality).
// Sonnet 5.5 is deliberately ONLY offered with thinking turned down: it rejects
// thinking:{type:"disabled"} outright, and "between_tools" is its lowest
// setting (no up-front thinking; with no tools in play the reply is text only).
// There is intentionally no "sonnet-5.5 with thinking" entry here.
export const LLM_CHOICES = Object.freeze({
  haiku: Object.freeze({
    model: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
  }),
  "haiku-5.5": Object.freeze({
    model: "claude-haiku-5-5",
    label: "Haiku 5.5",
  }),
  "sonnet-5.5": Object.freeze({
    model: "claude-sonnet-5-5",
    label: "Sonnet 5.5 (no thinking)",
    thinking: Object.freeze({ type: "between_tools" }),
  }),
});
export const DEFAULT_LLM = "haiku";

// Picks the model (and any thinking param) for a turn. A mode with its own
// explicit mode_models entry (deep_thoughtful) keeps that model exactly as
// before and is NOT affected by the switcher; every other mode follows
// active_llm. An unknown/missing active_llm falls back to Haiku rather than
// throwing, so a hand-edited config.json can't take the bot down mid-turn.
export function resolveLlm(config, effectiveMode) {
  const override = Object.hasOwn(config?.mode_models ?? {}, effectiveMode)
    ? config.mode_models[effectiveMode]
    : undefined;
  if (typeof override === "string" && effectiveMode !== "default") {
    return { model: override };
  }
  const choice = Object.hasOwn(LLM_CHOICES, config?.active_llm)
    ? LLM_CHOICES[config.active_llm]
    : LLM_CHOICES[DEFAULT_LLM];
  return choice.thinking ? { model: choice.model, thinking: choice.thinking } : { model: choice.model };
}

// Validates against LLM_CHOICES and rewrites config.json in place, preserving
// every other key — same validate-then-write shape as setActivePersonality.
export function setActiveLlm(name) {
  if (!Object.hasOwn(LLM_CHOICES, name)) {
    throw new Error(`unknown llm "${name}" (known: ${Object.keys(LLM_CHOICES).join(", ")})`);
  }
  const config = { ...readConfig(), active_llm: name };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  return config;
}

// Gates the self-improvement conversational path (src/speechPipeline.js) —
// only personalities named here may see that CAPABILITIES.md's
// self-improvement section exists, see their own past self-proposals, or
// have propose_task offered to them at all. Everyone else's deep_thoughtful
// turns run with no trace of the ability in their context, not merely a
// runtime refusal. Missing/malformed key means "nobody approved," not
// "everybody approved."
export function isSelfImproveApproved(personalityName, config = readConfig()) {
  const { self_improve_personalities } = config;
  return (
    Array.isArray(self_improve_personalities) &&
    self_improve_personalities.includes(personalityName)
  );
}

// Gates friendly mode's own routing through Claude Code (src/speechPipeline.js's
// useClaudeCode) — separate from DEEP_THOUGHTFUL_PROVIDER, which only ever
// governs deep_thoughtful's loop. A personality named here has its ordinary
// conversation billed against the operator's Claude Pro/Max/Team subscription
// (CLAUDE_CODE_OAUTH_TOKEN permitting) instead of the metered Anthropic API.
// Same fail-closed shape as isSelfImproveApproved: missing/malformed key means
// nobody gets it, not everybody.
export function isClaudeCodeChatApproved(personalityName, config = readConfig()) {
  const { claude_code_chat_personalities } = config;
  return (
    Array.isArray(claude_code_chat_personalities) &&
    claude_code_chat_personalities.includes(personalityName)
  );
}

// Available personalities = subdirectories of personalities/, same rule the
// speech/canned pipelines use to resolve an active_personality by name.
export function listPersonalities() {
  return fs
    .readdirSync(PERSONALITIES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Validates against listPersonalities() and rewrites config.json in place,
// preserving every other key. Throws on an unknown name rather than writing
// a config.json that would then fail to resolve a personality dir.
export function setActivePersonality(name) {
  const known = listPersonalities();
  if (!known.includes(name)) {
    throw new Error(`unknown personality "${name}" (known: ${known.join(", ")})`);
  }
  const config = { ...readConfig(), active_personality: name };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  return config;
}

let lastActivePersonality;

// Returns true the first time a given active_personality differs from the
// previously observed one. The very first call after boot never reports a
// change — there's nothing to have changed from yet.
export function checkPersonalityChanged(activePersonality) {
  const initialized = lastActivePersonality !== undefined;
  const changed = initialized && activePersonality !== lastActivePersonality;
  lastActivePersonality = activePersonality;
  return changed;
}
