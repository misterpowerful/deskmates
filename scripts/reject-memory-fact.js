import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { log } from "../src/logger.js";
import { readMemoryFacts, removeMemoryFact } from "../src/longTermMemory.js";

// Removes a bad or stale long-term-memory fact entirely — the memory.json
// equivalent of scripts/reject-insight.js. There's no ledger to keep: a
// deleted fact can simply be re-saved by saying the trigger phrase again if
// it turns out to still be wanted.
//
// Usage: npm run reject-memory-fact -- <personality> <index>

function fatal(message) {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function parseCliArgs() {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [personality, indexArg] = positionals;
  if (!personality || indexArg === undefined) {
    fatal("Usage: npm run reject-memory-fact -- <personality> <index>");
  }
  const index = Number(indexArg);
  if (!Number.isInteger(index) || index < 0) {
    fatal(`<index> must be a non-negative integer, got "${indexArg}".`);
  }
  return { personality, index };
}

function printFact(fact, index) {
  console.log(`\nIndex ${index}`);
  console.log(`Tags: ${(fact.tags ?? []).join(", ") || "(none)"}`);
  console.log(`Saved: ${fact.savedAt ?? "(unknown)"}\n`);
  console.log(`  "${fact.fact}"\n`);
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

  let facts;
  try {
    facts = readMemoryFacts(personality);
  } catch (err) {
    fatal(err.message);
    return;
  }

  if (index >= facts.length) {
    fatal(`Index ${index} out of range — ${personality} has ${facts.length} fact(s).`);
    return;
  }

  printFact(facts[index], index);

  const confirmed = await confirm(
    `Permanently delete this memory fact for "${personality}"? This cannot be undone`,
  );
  if (!confirmed) {
    log("Aborted — not rejected.");
    return;
  }

  try {
    removeMemoryFact(personality, index);
  } catch (err) {
    fatal(err.message);
    return;
  }
  log(`Rejected (deleted) memory fact ${index} for ${personality}.`);
}

main();
