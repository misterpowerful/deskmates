import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { log } from "../src/logger.js";
import { readInsights, removeInsight } from "../src/longTermMemory.js";

// Removes a proposed (or previously approved) insight entirely — unlike
// reject-task.js, there's no tasks/rejected-style ledger to keep: deleting
// the entry frees its source tag(s) up so scripts/run-reflection.js can
// naturally reconsider them next week if the pattern is still genuinely
// there (see run-reflection.js's tagsAlreadyCovered).
//
// Usage: npm run reject-insight -- <personality> <index>

function fatal(message) {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function parseCliArgs() {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [personality, indexArg] = positionals;
  if (!personality || indexArg === undefined) {
    fatal("Usage: npm run reject-insight -- <personality> <index>");
  }
  const index = Number(indexArg);
  if (!Number.isInteger(index) || index < 0) {
    fatal(`<index> must be a non-negative integer, got "${indexArg}".`);
  }
  return { personality, index };
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
  let insights;
  try {
    insights = readInsights(personality);
  } catch (err) {
    fatal(err.message);
    return;
  }

  if (index >= insights.length) {
    fatal(`Index ${index} out of range — ${personality} has ${insights.length} insight(s).`);
    return;
  }

  const insight = insights[index];
  printInsight(insight, index);

  const confirmed = await confirm(
    `Permanently delete this insight for "${personality}"? This cannot be undone`,
  );
  if (!confirmed) {
    log("Aborted — not rejected.");
    return;
  }

  try {
    removeInsight(personality, index);
  } catch (err) {
    fatal(err.message);
    return;
  }
  log(`Rejected (deleted) insight ${index} for ${personality}.`);
}

main();
