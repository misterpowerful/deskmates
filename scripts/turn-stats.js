// Reads logs/turns.db and answers the questions the billing console can't:
// how often deep_thoughtful actually runs and why, what a turn costs by mode,
// what tool use adds, and whether the latency budget is being met.
//
//   npm run turn-stats            -- last 7 days
//   npm run turn-stats -- 30      -- last 30 days
//
// Prices are USD per million tokens and are hardcoded below — they are a
// convenience for spotting proportions, not a billing source of truth. The
// authoritative number is always the Anthropic console.

import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = path.join(process.cwd(), "logs", "turns.db");
const days = Number(process.argv[2] ?? 7);
const since = new Date(Date.now() - days * 86400_000).toISOString();

// Per million tokens. Update if pricing changes.
const PRICES = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
};

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// provider "claude-code" turns are billed against the operator's Claude
// subscription (see src/turnLog.js's estimateCost) — $0 marginal cost by
// construction, same reasoning as there, kept in sync by hand since this
// script maintains its own copy of PRICES.
const cost = (row) => {
  if (row.provider === "claude-code") return 0;
  const p = PRICES[row.model];
  if (!p) return 0;
  return ((row.input_tokens ?? 0) * p.input + (row.output_tokens ?? 0) * p.output) / 1e6;
};

const rows = db
  .prepare("SELECT * FROM turns WHERE ts >= ? AND ok = 1 ORDER BY ts")
  .all(since);

if (rows.length === 0) {
  console.log(`No turns logged in the last ${days} day(s).`);
  process.exit(0);
}

const fmt = (n, d = 2) => Number(n).toFixed(d);
const pct = (n, total) => (total ? fmt((n / total) * 100, 1) : "0.0");

console.log(`\nDeskmates turn stats — last ${days} day(s), ${rows.length} turns\n`);

// --- by effective mode ---
const byMode = {};
for (const r of rows) {
  const k = r.effective_mode ?? "unknown";
  byMode[k] ??= { n: 0, cost: 0, inTok: 0, outTok: 0, ms: 0, rounds: 0 };
  const b = byMode[k];
  b.n++;
  b.cost += cost(r);
  b.inTok += r.input_tokens ?? 0;
  b.outTok += r.output_tokens ?? 0;
  b.ms += r.ms_total ?? 0;
  b.rounds += r.llm_rounds ?? 0;
}
const totalCost = Object.values(byMode).reduce((a, b) => a + b.cost, 0);

console.log("BY MODE");
console.log("  mode                turns    share      cost   $/turn   avg ms   avg rounds");
for (const [mode, b] of Object.entries(byMode).sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(
    `  ${mode.padEnd(18)} ${String(b.n).padStart(5)}   ${pct(b.n, rows.length).padStart(5)}%  ` +
      `$${fmt(b.cost, 4).padStart(7)}  $${fmt(b.cost / b.n, 4)}  ${String(Math.round(b.ms / b.n)).padStart(6)}   ${fmt(b.rounds / b.n, 2).padStart(5)}`,
  );
}
console.log(`  ${"TOTAL".padEnd(18)} ${String(rows.length).padStart(5)}            $${fmt(totalCost, 4)}`);
console.log(`  projected 30-day: $${fmt((totalCost / days) * 30, 2)}\n`);

// --- why deep_thoughtful engaged ---
const deep = rows.filter((r) => r.effective_mode === "deep_thoughtful");
if (deep.length) {
  console.log("DEEP_THOUGHTFUL — WHY IT ENGAGED");
  const byReason = {};
  for (const r of deep) {
    const k = r.deep_reason ?? "unknown";
    byReason[k] ??= { n: 0, cost: 0 };
    byReason[k].n++;
    byReason[k].cost += cost(r);
  }
  for (const [reason, b] of Object.entries(byReason).sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${reason.padEnd(18)} ${String(b.n).padStart(5)} turns  ${pct(b.n, deep.length).padStart(5)}% of deep  $${fmt(b.cost, 4)}`,
    );
  }
  // sticky_carryover is the one worth watching: those are turns that ran on
  // the expensive model without the user asking for it on that turn.
  const carry = byReason.sticky_carryover?.n ?? 0;
  if (carry) {
    console.log(
      `  -> ${carry} turn(s) inherited deep_thoughtful from an earlier trigger rather than being asked for directly.`,
    );
  }
  console.log();
}

// --- tool usage ---
const withTools = rows.filter((r) => r.tool_calls || (r.llm_rounds ?? 1) > 1);
if (withTools.length) {
  const plain = rows.filter((r) => !withTools.includes(r));
  const avg = (set, f) => (set.length ? set.reduce((a, r) => a + f(r), 0) / set.length : 0);
  console.log("TOOL USE");
  console.log(
    `  tool turns   ${String(withTools.length).padStart(5)}  ${pct(withTools.length, rows.length)}%  ` +
      `$${fmt(avg(withTools, cost), 4)}/turn  ${Math.round(avg(withTools, (r) => r.ms_total ?? 0))}ms  ` +
      `${fmt(avg(withTools, (r) => r.llm_rounds ?? 1), 2)} rounds`,
  );
  console.log(
    `  plain turns  ${String(plain.length).padStart(5)}  ${pct(plain.length, rows.length)}%  ` +
      `$${fmt(avg(plain, cost), 4)}/turn  ${Math.round(avg(plain, (r) => r.ms_total ?? 0))}ms`,
  );
  const ratio = avg(plain, cost) ? avg(withTools, cost) / avg(plain, cost) : 0;
  if (ratio) console.log(`  -> a tool turn costs ~${fmt(ratio, 1)}x a plain one`);

  const toolCounts = {};
  for (const r of rows) {
    for (const t of (r.tool_calls ?? "").split(",").filter(Boolean)) {
      toolCounts[t] = (toolCounts[t] ?? 0) + 1;
    }
  }
  const searches = rows.reduce((a, r) => a + (r.web_searches ?? 0), 0);
  if (searches) toolCounts["web_search (billed searches)"] = searches;
  if (Object.keys(toolCounts).length) {
    console.log("  tools fired:");
    for (const [t, n] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${t.padEnd(32)} ${n}`);
    }
  }
  console.log();
}

// --- latency ---
const lat = rows.filter((r) => r.ms_total != null).map((r) => r.ms_total).sort((a, b) => a - b);
if (lat.length) {
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
  console.log("LATENCY (total, ms)");
  console.log(`  p50 ${p(0.5)}   p90 ${p(0.9)}   p99 ${p(0.99)}   max ${lat[lat.length - 1]}`);
  console.log("  (the filler line has to cover this — compare against its duration)\n");
}

// --- failures ---
const fails = db
  .prepare("SELECT COUNT(*) AS n FROM turns WHERE ts >= ? AND ok = 0")
  .get(since);
if (fails.n) console.log(`FAILURES: ${fails.n} turn(s) errored in this window\n`);
