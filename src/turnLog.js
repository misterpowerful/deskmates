// Durable per-turn record of what the pipeline actually did: which mode was
// asked for vs. which one ran, which model that resolved to, how many tokens
// it burned, how many tool rounds it took, and how long each stage was.
//
// This exists because the alternative is inferring all of it from a billing
// chart after the fact. A console chart can say "you spent $X on Sonnet"; it
// cannot say which turns were deep_thoughtful, whether deep_thoughtful was
// entered deliberately or carried over from an earlier trigger, or what an
// average tool-using turn costs compared to a plain one. Those are the
// questions that decide whether anything needs optimizing, so they need to
// be recorded per turn, at the moment the turn happens.
//
// Storage: node:sqlite (built into Node 22+, no dependency, no native build
// step, no service to run or secure — same reasoning that ruled out Redis
// and Mongo for this project). If it isn't available, this degrades to
// appending JSONL rather than failing or silently dropping data.
//
// Never throws. A logging failure must not break a conversation turn.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { log, logError } from "./logger.js";

// node:sqlite is CJS-only from an ESM file's perspective; createRequire gives
// a synchronous require without making this module CJS.
const require = createRequire(import.meta.url);

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, "logs");
const DB_PATH = path.join(LOG_DIR, "turns.db");
const JSONL_PATH = path.join(LOG_DIR, "turns.jsonl");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT    NOT NULL,
  session_id        TEXT,
  personality       TEXT,
  requested_mode    TEXT,
  effective_mode    TEXT,
  deep_reason       TEXT,
  model             TEXT,
  provider          TEXT,
  kind              TEXT,
  channel           TEXT,
  transcript        TEXT,
  reply             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  llm_rounds        INTEGER,
  tool_calls        TEXT,
  web_searches      INTEGER,
  classifier_calls  INTEGER,
  ms_stt            INTEGER,
  ms_llm            INTEGER,
  ms_tts            INTEGER,
  ms_total          INTEGER,
  ok                INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_effective_mode ON turns(effective_mode);
CREATE INDEX IF NOT EXISTS idx_turns_model ON turns(model);

-- Claude plan (subscription) utilization as reported by the Agent SDK's
-- rate_limit_event messages during deep_thoughtful/claude-code calls. One
-- row per event; call_id groups the events emitted by a single query() call
-- so a call's own before/after movement can be measured (see usageSummary).
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  call_id         TEXT,
  rate_limit_type TEXT,
  utilization     REAL,
  resets_at       INTEGER,
  status          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rle_ts ON rate_limit_events(ts);
CREATE INDEX IF NOT EXISTS idx_rle_type ON rate_limit_events(rate_limit_type, resets_at);
`;

const COLUMNS = [
  "ts", "session_id", "personality", "requested_mode", "effective_mode",
  "deep_reason", "model", "provider", "kind", "channel", "transcript", "reply",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "llm_rounds", "tool_calls", "web_searches", "classifier_calls",
  "ms_stt", "ms_llm", "ms_tts", "ms_total", "ok", "error",
];

let db = null;
let insert = null;
let insertRateLimit = null;
let backend = "uninitialized";

function init() {
  if (backend !== "uninitialized") return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    // Dynamic require so a Node without node:sqlite falls through to JSONL
    // instead of failing at import time and taking the server with it.
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(DB_PATH);
    // WAL keeps a write from blocking concurrent reads (e.g. the stats
    // script running while the server is live).
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    // CREATE TABLE IF NOT EXISTS above is a no-op against a turns.db that
    // predates the `provider` column (added so deep_thoughtful's
    // claude-code routing can be told apart from the api path) — migrate
    // it in explicitly rather than losing existing rows to a DROP/recreate.
    const hasProviderColumn = db
      .prepare("PRAGMA table_info(turns)")
      .all()
      .some((c) => c.name === "provider");
    if (!hasProviderColumn) {
      db.exec("ALTER TABLE turns ADD COLUMN provider TEXT");
    }
    insert = db.prepare(
      `INSERT INTO turns (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
    );
    insertRateLimit = db.prepare(
      "INSERT INTO rate_limit_events (ts, call_id, rate_limit_type, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?, ?)",
    );
    backend = "sqlite";
    log("turnLog: using sqlite", { path: path.relative(ROOT, DB_PATH) });
  } catch (err) {
    backend = "jsonl";
    log("turnLog: sqlite unavailable, falling back to jsonl", {
      error: err?.message ?? String(err),
      path: path.relative(ROOT, JSONL_PATH),
    });
  }
}

function toRow(entry) {
  const usage = entry.usage ?? {};
  return [
    entry.ts ?? new Date().toISOString(),
    entry.sessionId ?? null,
    entry.personality ?? null,
    entry.requestedMode ?? null,
    entry.effectiveMode ?? null,
    entry.deepReason ?? null,
    entry.model ?? null,
    entry.provider ?? null,
    entry.kind ?? null,
    entry.channel ?? null,
    entry.transcript ?? null,
    entry.reply ?? null,
    usage.input_tokens ?? null,
    usage.output_tokens ?? null,
    usage.cache_read_input_tokens ?? null,
    usage.cache_creation_input_tokens ?? null,
    entry.llmRounds ?? null,
    entry.toolCalls?.length ? entry.toolCalls.join(",") : null,
    entry.webSearches ?? null,
    entry.classifierCalls ?? null,
    entry.timings?.stt ?? null,
    entry.timings?.llm ?? null,
    entry.timings?.tts ?? null,
    entry.totalElapsed ?? null,
    entry.ok === false ? 0 : 1,
    entry.error ?? null,
  ];
}

// Fire-and-forget. Deliberately scheduled with setImmediate so it lands after
// the current turn's response is already on the wire — the write itself is a
// local sub-millisecond append, but keeping it off the response path means it
// can never show up in the latency budget the filler line has to cover.
export function logTurn(entry) {
  setImmediate(() => {
    try {
      init();
      const row = toRow(entry);
      if (backend === "sqlite") {
        insert.run(...row);
      } else {
        const obj = Object.fromEntries(COLUMNS.map((c, i) => [c, row[i]]));
        fs.appendFileSync(JSONL_PATH, JSON.stringify(obj) + "\n");
      }
    } catch (err) {
      // Never breaks the conversation turn itself (the console log above
      // already recorded it) — but must not be swallowed either, since a
      // silently-failing insert is indistinguishable from "nothing happened
      // this turn" until someone notices the Turns tab is missing rows.
      // logError (not log) so this actually stands out in the journal.
      logError("turnLog: write failed", { error: err?.message ?? String(err), entry: { ts: entry.ts, kind: entry.kind } });
    }
  });
}

// Records one Agent SDK `rate_limit_event`'s info object. sqlite-only: the
// JSONL fallback has no query side, so there is nothing to gain from writing
// these there. Same never-throws, off-the-response-path contract as logTurn.
export function logRateLimitEvent(info, callId) {
  if (!info) return;
  setImmediate(() => {
    try {
      init();
      if (backend !== "sqlite") return;
      insertRateLimit.run(
        new Date().toISOString(),
        callId ?? null,
        info.rateLimitType ?? null,
        typeof info.utilization === "number" ? info.utilization : null,
        typeof info.resetsAt === "number" ? info.resetsAt : null,
        info.status ?? null,
      );
    } catch (err) {
      logError("turnLog: rate-limit event write failed", { error: err?.message ?? String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Retention. Turn rows hold verbatim transcripts and replies, so they are aged
// out rather than kept forever. Run from scripts/prune-turns.js (daily cron)
// in its own process; `dir` exists so tests can point at a scratch directory.
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_DAYS = 90;

// A missing/malformed config value falls back to the default rather than to
// "keep forever" or "delete everything".
export function resolveRetentionDays(config) {
  const d = config?.turn_log_retention_days;
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : DEFAULT_RETENTION_DAYS;
}

// Deletes turns and rate_limit_events older than `days` from turns.db (then
// VACUUMs so the file actually shrinks) and/or turns.jsonl (rewritten
// without the old lines). JSONL lines that don't parse or carry no usable ts
// are kept: dropping data we can't date is the less safe failure. Throws on
// an invalid `days`.
export function pruneOldTurns({ days, dir = LOG_DIR } = {}) {
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    throw new Error(`pruneOldTurns: days must be a positive number, got ${days}`);
  }
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  let deleted = 0;

  const dbPath = path.join(dir, "turns.db");
  if (fs.existsSync(dbPath)) {
    const { DatabaseSync } = require("node:sqlite");
    const conn = new DatabaseSync(dbPath);
    try {
      deleted += Number(conn.prepare("DELETE FROM turns WHERE ts < ?").run(cutoff).changes);
      // rate_limit_events carries its own ts column and grows unbounded right
      // alongside turns (a deep_thoughtful/claude-code call can emit several
      // events per turn) — age it out too, but guard the table's existence
      // since a pre-migration turns.db (or a test fixture) may not have it.
      const hasRateLimitEvents = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit_events'")
        .get();
      if (hasRateLimitEvents) {
        deleted += Number(conn.prepare("DELETE FROM rate_limit_events WHERE ts < ?").run(cutoff).changes);
      }
      // Plain VACUUM: incremental_vacuum only works on databases created
      // with auto_vacuum=INCREMENTAL, which existing turns.db files are not.
      conn.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      conn.exec("VACUUM;");
    } finally {
      conn.close();
    }
  }

  const jsonlPath = path.join(dir, "turns.jsonl");
  if (fs.existsSync(jsonlPath)) {
    const kept = [];
    for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ts;
      try {
        ts = JSON.parse(line)?.ts;
      } catch {
        ts = undefined;
      }
      if (typeof ts === "string" && ts < cutoff) deleted++;
      else kept.push(line);
    }
    const tmp = jsonlPath + ".tmp";
    fs.writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "");
    fs.renameSync(tmp, jsonlPath);
  }

  return { days, cutoff, deleted };
}

// ---------------------------------------------------------------------------
// Read side. Used by the HTTP API that backs the console's Turns and Costs
// tabs. Cost is computed here rather than in the browser so there is exactly
// one price table in the codebase.
// ---------------------------------------------------------------------------

// USD per million tokens. A convenience for spotting proportions and trends
// — the Anthropic console remains the billing source of truth.
export const PRICES = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  // Assumed equal to Haiku 4.5's rate — confirm against Anthropic's pricing
  // page; the console remains the billing source of truth.
  "claude-haiku-5-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
  // Assumed equal to Sonnet 5's standard rate — confirm against Anthropic's
  // pricing page; the console remains the billing source of truth.
  "claude-sonnet-5-5": { input: 3, output: 15 },
};

// Cache pricing is a fixed multiple of the model's input price: reads cost
// 0.1x, 5-minute cache writes 1.25x. Without these, every cached token was
// priced at $0 — and a heavy system prompt means most of a turn's input IS
// cache traffic, so metered spend was understated.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

// What these tokens WOULD cost at API rates, regardless of how the turn was
// actually billed. For a subscription turn this is the "API-equivalent"
// figure — useful for scale, never money actually spent.
export function estimateEquivalentCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    ((inputTokens ?? 0) * p.input +
      (cacheReadTokens ?? 0) * p.input * CACHE_READ_MULT +
      (cacheWriteTokens ?? 0) * p.input * CACHE_WRITE_MULT +
      (outputTokens ?? 0) * p.output) /
    1e6
  );
}

// provider "claude-code" means this turn ran through the Claude Agent SDK
// authenticated with CLAUDE_CODE_OAUTH_TOKEN — billed against the
// operator's Claude Pro/Max/Team subscription, not metered per-token API
// spend, so it costs $0 of real money by construction. A claude-code turn
// that actually ran on the API key instead (no OAuth token configured — see
// claudeCodeAuthEnv in speechPipeline.js) is logged with provider
// "claude-code-metered", not "claude-code", specifically so it does NOT hit
// this branch and still gets priced like real API spend.
export function estimateCost(model, inputTokens, outputTokens, provider, cacheReadTokens = 0, cacheWriteTokens = 0) {
  if (provider === "claude-code") return 0;
  return estimateEquivalentCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
}

// Returns null when no turns have been recorded yet (no db file), so callers
// can answer with an empty result instead of a 500 on a fresh install.
function openForRead() {
  init();
  if (backend !== "sqlite" || !fs.existsSync(DB_PATH)) return null;
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

// Most recent turns first. `limit` is clamped — this feeds a phone-sized
// list, and an unbounded query over a long-lived db would be a memory
// hazard on a small VPS.
export function queryTurns({ limit = 100, offset = 0, mode = null, since = null } = {}) {
  const read = openForRead();
  if (!read) return { turns: [], total: 0 };
  try {
    const where = [];
    const params = [];
    if (mode) {
      where.push("effective_mode = ?");
      params.push(mode);
    }
    if (since) {
      where.push("ts >= ?");
      params.push(since);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = read.prepare(`SELECT COUNT(*) AS n FROM turns ${clause}`).get(...params).n;
    const rows = read
      .prepare(`SELECT * FROM turns ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(Math.max(1, limit), 500), Math.max(0, offset));
    return {
      total,
      turns: rows.map((r) => ({
        ...r,
        cost: estimateCost(r.model, r.input_tokens, r.output_tokens, r.provider, r.cache_read_tokens, r.cache_write_tokens),
        // What the turn would cost at API rates. Equal to `cost` for a
        // metered turn; the API-equivalent figure for a subscription one.
        equivalent_cost: estimateEquivalentCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens),
        // Distinct from cost === 0 for an ordinary $0 turn (e.g. no usage
        // recorded): tells the UI to render "subscription" instead of a
        // dollar figure, so a truly free-of-marginal-cost turn doesn't read
        // as missing data.
        unmetered: r.provider === "claude-code",
        tool_calls: r.tool_calls ? r.tool_calls.split(",") : [],
      })),
    };
  } finally {
    read.close();
  }
}

// One row per calendar day (UTC), split by model so the chart can stack them
// — which model a day's spend came from is the whole point of looking.
export function dailyCosts({ days = 30 } = {}) {
  const read = openForRead();
  if (!read) return { days: [], models: [] };
  try {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = read
      .prepare(
        `SELECT substr(ts, 1, 10) AS day, model, provider,
                COUNT(*) AS turns,
                SUM(COALESCE(input_tokens, 0))  AS input_tokens,
                SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                SUM(COALESCE(cache_read_tokens, 0))  AS cache_read_tokens,
                SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens
         FROM turns
         WHERE ts >= ? AND ok = 1 AND model IS NOT NULL
         GROUP BY day, model, provider
         ORDER BY day`,
      )
      .all(since);

    const byDay = new Map();
    const models = new Set();
    for (const r of rows) {
      // A subscription-billed (claude-code) turn and a metered (api) turn
      // on the same underlying model are not the same line on this chart —
      // merging them would silently absorb real spend into a $0 bucket, or
      // vice versa make free turns look like they cost something. Keying
      // by a display label rather than the bare model name keeps them
      // separate without the frontend needing to know about providers.
      const label = r.provider === "claude-code" ? `${r.model} (subscription)` : r.model;
      models.add(label);
      const entry = byDay.get(r.day) ?? { day: r.day, total: 0, turns: 0, byModel: {} };
      const cost = estimateCost(r.model, r.input_tokens, r.output_tokens, r.provider, r.cache_read_tokens, r.cache_write_tokens);
      entry.byModel[label] = {
        cost,
        equivalentCost: estimateEquivalentCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens),
        turns: r.turns,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        unmetered: r.provider === "claude-code",
      };
      entry.total += cost;
      entry.turns += r.turns;
      byDay.set(r.day, entry);
    }

    // Fill gaps so the chart shows days with no traffic as zero rather than
    // silently compressing the x-axis.
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      out.push(byDay.get(day) ?? { day, total: 0, turns: 0, byModel: {} });
    }
    return { days: out, models: [...models] };
  } finally {
    read.close();
  }
}

// ---------------------------------------------------------------------------
// Usage summary: Deskmates's own usage on one screen — metered API spend,
// subscription-covered tokens, and where the account's plan limits stand.
// ---------------------------------------------------------------------------

const emptyTokens = () => ({ input: 0, cache_read: 0, cache_write: 0, output: 0 });
const sumTokens = (t) => t.input + t.cache_read + t.cache_write + t.output;

// Overnight jobs (scripts/run-*.js) run the claude CLI with the API key
// stripped, so they are subscription-covered. The CLI returns one final JSON
// result rather than a stream, so these logs carry tokens and an
// API-equivalent total_cost_usd but no plan utilization.
function readOvernightLogs(since) {
  const out = { runs: 0, tokens: emptyTokens(), equivalent_usd: 0 };
  let files;
  try {
    files = fs.readdirSync(LOG_DIR).filter((f) => /^self-.*\.json$/.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), "utf8"));
      if (!d.timestamp || d.timestamp < since || !d.claude) continue;
      const u = d.claude.usage ?? {};
      out.runs += 1;
      out.tokens.input += u.input_tokens ?? 0;
      out.tokens.cache_read += u.cache_read_input_tokens ?? 0;
      out.tokens.cache_write += u.cache_creation_input_tokens ?? 0;
      out.tokens.output += u.output_tokens ?? 0;
      out.equivalent_usd += d.claude.totalCostUsd ?? 0;
    } catch {
      // One unreadable log must not blank the whole summary.
    }
  }
  return out;
}

// The SDK does not document whether rate_limit_event.utilization is a
// fraction (0.45) or a percent (45). The status-line rate-limit headers it
// derives from are fractions, so auto-detect on that basis — but a fresh
// account sitting at, say, 0.6% would look like 60%, so
// RATE_LIMIT_UTILIZATION_SCALE=fraction|percent pins it once confirmed.
function detectScale(read) {
  const pinned = process.env.RATE_LIMIT_UTILIZATION_SCALE;
  if (pinned === "fraction" || pinned === "percent") return pinned;
  const max = read.prepare("SELECT MAX(utilization) AS m FROM rate_limit_events WHERE utilization IS NOT NULL").get().m;
  if (max == null) return null;
  return max <= 1 ? "fraction" : "percent";
}

// resets_at arrives as epoch seconds (some CLI paths use ms) — normalize.
const toIso = (t) => (t == null ? null : new Date(t < 1e12 ? t * 1000 : t).toISOString());

function planWindows(read, since) {
  const scale = detectScale(read);
  const k = scale === "fraction" ? 100 : 1;
  const plan = { scale, five_hour: null, seven_day: null };
  if (!scale) return plan;

  for (const type of ["five_hour", "seven_day"]) {
    const latest = read
      .prepare(
        `SELECT utilization, resets_at, ts, status FROM rate_limit_events
         WHERE rate_limit_type = ? AND utilization IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(type);
    if (!latest) continue;

    // Deskmates's own movement of the meter: for every deep_thoughtful call
    // in the CURRENT window, how far utilization rose between that call's
    // first and last event. Coarse by nature (one turn is a small slice of a
    // window, and the value may only tick in whole steps), so it is a floor,
    // not an exact figure — and it only covers deep_thoughtful turns.
    const windowClause = latest.resets_at == null ? "ts >= ?" : "resets_at = ?";
    const calls = read
      .prepare(
        `SELECT MIN(utilization) AS lo, MAX(utilization) AS hi
         FROM rate_limit_events
         WHERE rate_limit_type = ? AND utilization IS NOT NULL
           AND call_id IS NOT NULL AND ${windowClause}
         GROUP BY call_id`,
      )
      .all(type, latest.resets_at ?? since);
    const bbPoints = calls.reduce((a, c) => a + Math.max(0, c.hi - c.lo), 0) * k;
    const used = latest.utilization * k;

    const round2 = (n) => Math.round(n * 100) / 100;
    plan[type] = {
      used_pct: round2(used),
      deskmates_pct: round2(Math.min(bbPoints, used)),
      other_pct: round2(Math.max(0, used - bbPoints)),
      resets_at: toIso(latest.resets_at),
      updated_at: latest.ts,
      status: latest.status,
      calls: calls.length,
      calls_that_moved_meter: calls.filter((c) => c.hi > c.lo).length,
    };
  }
  return plan;
}

export function usageSummary({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const paths = {
    api: { turns: 0, tokens: emptyTokens(), billed_usd: 0 },
    deep_thought: { turns: 0, tokens: emptyTokens(), equivalent_usd: 0 },
    overnight: readOvernightLogs(since),
  };
  let plan = { scale: null, five_hour: null, seven_day: null };

  const read = openForRead();
  if (read) {
    try {
      const rows = read
        .prepare(
          `SELECT provider, model, COUNT(*) AS turns,
                  SUM(COALESCE(input_tokens, 0))       AS input,
                  SUM(COALESCE(cache_read_tokens, 0))  AS cache_read,
                  SUM(COALESCE(cache_write_tokens, 0)) AS cache_write,
                  SUM(COALESCE(output_tokens, 0))      AS output
           FROM turns
           WHERE ts >= ? AND ok = 1 AND model IS NOT NULL
           GROUP BY provider, model`,
        )
        .all(since);
      for (const r of rows) {
        // provider "claude-code" = subscription; everything else
        // (including "claude-code-metered") is real API spend.
        const bucket = r.provider === "claude-code" ? paths.deep_thought : paths.api;
        bucket.turns += r.turns;
        bucket.tokens.input += r.input;
        bucket.tokens.cache_read += r.cache_read;
        bucket.tokens.cache_write += r.cache_write;
        bucket.tokens.output += r.output;
        const usd = estimateEquivalentCost(r.model, r.input, r.output, r.cache_read, r.cache_write);
        if (bucket === paths.api) bucket.billed_usd += usd;
        else bucket.equivalent_usd += usd;
      }
      plan = planWindows(read, since);
    } finally {
      read.close();
    }
  }

  const total = emptyTokens();
  for (const p of Object.values(paths)) for (const key of Object.keys(total)) total[key] += p.tokens[key];
  paths.api.total_tokens = sumTokens(paths.api.tokens);
  paths.deep_thought.total_tokens = sumTokens(paths.deep_thought.tokens);
  paths.overnight.total_tokens = sumTokens(paths.overnight.tokens);

  return {
    days,
    since,
    tokens: { ...total, total: sumTokens(total) },
    billed_usd: paths.api.billed_usd,
    subscription_equivalent_usd: paths.deep_thought.equivalent_usd + paths.overnight.equivalent_usd,
    paths,
    plan,
  };
}
