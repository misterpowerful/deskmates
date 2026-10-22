import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { log } from "../src/logger.js";
import { validateInsights } from "../src/dataValidation.js";

// Flips a proposed insight to "approved" so it becomes eligible for
// deep_thoughtful mode to surface (src/speechPipeline.js's
// getApprovedInsightsBlock). Mirrors approve-task.js in spirit — a human
// approval gate before anything self-generated goes live — but insights
// live as indexed entries in personalities/<name>/insights.json rather
// than files to move.
//
// Usage: npm run approve-insight -- <personality> <index>

const ROOT = process.cwd();

function fatal(message) {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function parseCliArgs() {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [personality, indexArg] = positionals;
  if (!personality || indexArg === undefined) {
    fatal("Usage: npm run approve-insight -- <personality> <index>");
  }
  const index = Number(indexArg);
  if (!Number.isInteger(index) || index < 0) {
    fatal(`<index> must be a non-negative integer, got "${indexArg}".`);
  }
  return { personality, index };
}

function insightsPath(personality) {
  return path.join(ROOT, "personalities", personality, "insights.json");
}

function loadInsights(filePath) {
  if (!fs.existsSync(filePath)) {
    fatal(`No insights.json for that personality: ${path.relative(ROOT, filePath)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    fatal(`${path.relative(ROOT, filePath)} is not a JSON array.`);
  }
  return parsed;
}

function printInsight(insight, index) {
  console.log(`\nIndex ${index}  (status: ${insight.status})`);
  console.log(`Tags: ${(insight.sourceTags ?? []).join(", ") || "(none)"}`);
  console.log(`Created: ${insight.createdAt ?? "(unknown)"}\n`);
  console.log(`  "${insight.insight}"\n`);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/n) `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const { personality, index } = parseCliArgs();
  const filePath = insightsPath(personality);
  const insights = loadInsights(filePath);

  if (index >= insights.length) {
    fatal(`Index ${index} out of range — ${personality} has ${insights.length} insight(s).`);
  }

  const insight = insights[index];
  printInsight(insight, index);

  if (insight.status === "approved") {
    log("Already approved — nothing to do.");
    return;
  }

  const confirmed = await confirm(`Approve this insight for "${personality}"?`);
  if (!confirmed) {
    log("Aborted — not approved.");
    return;
  }

  insights[index] = { ...insight, status: "approved" };
  const check = validateInsights(insights);
  if (!check.ok) fatal(`Refusing to write invalid insights file: ${check.errors.join("; ")}`);
  fs.writeFileSync(filePath, JSON.stringify(insights, null, 2) + "\n");
  log(`Approved insight ${index} for ${personality}.`);
}

main();
