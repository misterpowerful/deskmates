import "dotenv/config";
import "../src/httpAgent.js";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "../src/logger.js";
import { validateInsights } from "../src/dataValidation.js";

// Weekly cron: looks for patterns across each personality's accumulated
// long-term-memory facts (personalities/<name>/memory.json, tagged by
// src/longTermMemory.js's condenseAndStore) and writes them up as insights.
// Insights are auto-approved on write (no human gate) — they go live for
// deep_thoughtful mode immediately via getApprovedInsightsBlock.
// scripts/reject-insight.js remains the way to remove a bad one after the
// fact; scripts/approve-insight.js is now a no-op for anything this script
// produces (kept for any insight manually reset to "proposed").
//
// The actual work here is a single-shot "summarize this group of facts, or
// decline" completion, not repo exploration or code writing, so — like
// src/longTermMemory.js's own condenseAndStore — this calls the Anthropic
// SDK directly rather than invoking Claude Code headlessly.
//
// Usage: node scripts/run-reflection.js   (cron: weekly)

const ROOT = process.cwd();
const PERSONALITIES_DIR = path.join(ROOT, "personalities");
const LOGS_DIR = path.join(ROOT, "logs");
const REFLECTION_MODEL = "claude-sonnet-5";
const MIN_FACTS_FOR_TAG = 3;

const anthropic = new Anthropic();

const OBSERVATION_SYSTEM_PROMPT = `You will be given a set of facts remembered about a person, all sharing one tag/theme. State only what these facts show. Do not predict what the person will want, like, or do next. An observation describes a pattern that already exists in what's been said; a prediction guesses at something that hasn't. If you can't produce a genuine observation without guessing, respond with exactly the single word NONE and nothing else. Otherwise, output ONLY the observation itself — one or two sentences, no preamble, no quotation marks, no explanation.`;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function listPersonalities() {
  return fs
    .readdirSync(PERSONALITIES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function memoryPath(name) {
  return path.join(PERSONALITIES_DIR, name, "memory.json");
}

function insightsPath(name) {
  return path.join(PERSONALITIES_DIR, name, "insights.json");
}

function loadJsonArray(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Facts predating tagging (or from a condensation call whose tag parsing
// fell back) may have no `tags` field at all — treated as [], same
// forward-compat rule getLongTermMemoryBlock already follows. A fact with
// multiple tags is grouped under each one.
function groupFactsByTag(facts) {
  const groups = new Map();
  for (const entry of facts) {
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    for (const tag of tags) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(entry);
    }
  }
  return groups;
}

// A tag already covered by a live insight (proposed and awaiting a
// decision, or already approved) isn't reconsidered — that would just pile
// up duplicate observations about the same pattern every week. Rejecting
// an insight deletes it outright (see reject-insight.js), which is what
// frees its tag(s) up for reconsideration.
function tagsAlreadyCovered(insights) {
  const covered = new Set();
  for (const insight of insights) {
    for (const tag of insight.sourceTags ?? []) covered.add(tag);
  }
  return covered;
}

async function proposeObservation(tag, entries) {
  const factList = entries.map((e) => `- ${e.fact}`).join("\n");
  const response = await anthropic.messages.create({
    model: REFLECTION_MODEL,
    max_tokens: 200,
    system: OBSERVATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Tag: ${tag}\n\nFacts:\n${factList}` }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  const text = (textBlock?.text ?? "").trim();
  if (!text || text.toUpperCase() === "NONE") return null;
  return text;
}

async function reflectOnPersonality(name) {
  const facts = loadJsonArray(memoryPath(name));
  const groups = groupFactsByTag(facts);
  const insights = loadJsonArray(insightsPath(name));
  const covered = tagsAlreadyCovered(insights);

  // Largest groups first: two tags that mostly cover the same facts (e.g.
  // "music" and "preferences" on a set of jazz-related entries) would
  // otherwise both qualify and produce two near-duplicate observations in
  // the same run. Processing the broader group first and immediately
  // marking its tags covered (below) means a smaller, overlapping group
  // gets skipped in favor of the more informative one, in this run too —
  // not just across weeks.
  const candidates = [...groups.entries()]
    .filter(([tag, entries]) => entries.length >= MIN_FACTS_FOR_TAG && !covered.has(tag))
    .sort((a, b) => b[1].length - a[1].length);

  const result = {
    personality: name,
    factCount: facts.length,
    candidateTags: candidates.map(([tag, entries]) => ({ tag, factCount: entries.length })),
    proposed: [],
    skipped: [],
  };

  if (candidates.length === 0) {
    return result;
  }

  let changed = false;
  for (const [tag, entries] of candidates) {
    if (covered.has(tag)) {
      // Covered by an insight generated earlier in this same run.
      result.skipped.push({ tag, reason: "covered_by_overlapping_tag_this_run" });
      continue;
    }

    let observation;
    try {
      observation = await proposeObservation(tag, entries);
    } catch (err) {
      log(`run-reflection: ${name}/${tag} observation call failed`, {
        error: err?.message ?? String(err),
      });
      result.skipped.push({ tag, reason: "error", error: err?.message ?? String(err) });
      continue;
    }

    if (!observation) {
      result.skipped.push({ tag, reason: "no_genuine_observation" });
      continue;
    }

    // Union of every tag actually present on the contributing facts, not
    // just the one that triggered this candidate — a fact tagged both
    // "music" and "preferences" makes the resulting insight traceable to
    // both, and marking all of them covered (below) keeps a smaller,
    // overlapping group later in this same loop — or next week — from
    // producing a near-duplicate observation.
    const sourceTags = [...new Set(entries.flatMap((e) => (Array.isArray(e.tags) ? e.tags : [])))];
    for (const t of sourceTags) covered.add(t);

    insights.push({
      insight: observation,
      sourceTags,
      status: "approved",
      createdAt: new Date().toISOString(),
    });
    result.proposed.push({ tag, sourceTags, insight: observation });
    changed = true;
  }

  if (changed) {
    const check = validateInsights(insights);
    if (check.ok) {
      fs.writeFileSync(insightsPath(name), JSON.stringify(insights, null, 2) + "\n");
    } else {
      // Light gate: never persist a malformed insights file.
      log(`run-reflection: ${name} insights failed validation, not written`, { errors: check.errors });
      result.skipped.push({ tag: "*", reason: "invalid_insights", errors: check.errors });
      result.proposed = [];
    }
  }

  return result;
}

function writeLog(entry) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `self-reflection-${timestamp()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
  log(`Wrote reflection log to ${path.relative(ROOT, logPath)}`);
}

async function main() {
  const personalities = listPersonalities();
  const perPersonality = [];

  for (const name of personalities) {
    perPersonality.push(await reflectOnPersonality(name));
  }

  const totalProposed = perPersonality.reduce((sum, r) => sum + r.proposed.length, 0);

  if (totalProposed === 0) {
    log("run-reflection: no new insights this run.");
  } else {
    const touched = perPersonality.filter((r) => r.proposed.length > 0).length;
    log(`run-reflection: auto-approved ${totalProposed} insight(s) across ${touched} personality(ies).`);
  }

  writeLog({
    timestamp: new Date().toISOString(),
    outcome: totalProposed > 0 ? "proposed" : "no_insights",
    personalities: perPersonality,
  });
}

main();
