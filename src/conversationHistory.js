// Chronological, session-scoped view over turns.db for a chat-style client
// (a native app, or the mobile webapp) that wants one conversation's history
// rendered as a scrollback and cached offline. Distinct from turnLog.js's
// queryTurns, which feeds the console's Turns tab: newest-first, across every
// session, and paged by row count rather than shaped into chat turns.
//
// Deliberately its own tiny read-only module (own DatabaseSync handle, no
// shared module-level state) rather than a new turnLog.js export — turnLog's
// db/backend singleton is initialized lazily by the write path and is awkward
// to point at a test directory; a plain `dir` parameter keeps this testable
// the same way turnLog.js's own pruneOldTurns already is.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 1000;

// Coerces an arbitrary caller-supplied limit (string from a query param,
// undefined, NaN, negative, huge) into a safe positive integer rather than
// trusting it to already be clean.
function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(n), MAX_HISTORY_LIMIT);
}

// Returns { sessionId, turns } where turns is chat-shaped and time-ordered
// oldest-first: one entry per non-empty transcript ("user") and per non-empty
// reply ("assistant"), sharing the parent row's timestamp. A row with no
// reply (a failed turn — see server.js's logTurn calls on the catch path)
// contributes only its user entry, never a blank/error assistant bubble.
//
// When a session has more rows than `limit`, the *most recent* `limit` rows
// are returned (still oldest-first within that window) — turns.db keeps
// rows for turn_log_retention_days (default 90), far longer than any one
// conversation, so "oldest limit rows" would hydrate ancient history instead
// of what was just said.
//
// `sessionId` is required and validated here (not left to the caller) since
// this also gets called directly, not just from behind server.js's HTTP
// param parsing. `dir` defaults to ./logs, overridable for tests.
//
// `since` (an ISO-8601 string, compared lexically against the TEXT `ts`
// column — safe because turnLog.js always writes ts via Date.toISOString())
// restricts the result to rows at or after that instant, e.g. the caller's
// local midnight for a "pull today's history" action. Omit it for the old
// "most recent `limit` rows regardless of age" behavior.
export function getConversationHistory({ sessionId, limit, since, dir } = {}) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError("getConversationHistory: sessionId must be a non-empty string");
  }

  const dbDir = dir ?? path.join(process.cwd(), "logs");
  const dbPath = path.join(dbDir, "turns.db");
  if (!fs.existsSync(dbPath)) return { sessionId, turns: [] };

  const hasSince = typeof since === "string" && since.trim() !== "";

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ts, transcript, reply
         FROM turns
         WHERE session_id = ?${hasSince ? " AND ts >= ?" : ""}
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(...(hasSince ? [sessionId, since] : [sessionId]), clampLimit(limit))
      .reverse();

    const turns = [];
    for (const row of rows) {
      if (typeof row.transcript === "string" && row.transcript !== "") {
        turns.push({ ts: row.ts, role: "user", text: row.transcript });
      }
      if (typeof row.reply === "string" && row.reply !== "") {
        turns.push({ ts: row.ts, role: "assistant", text: row.reply });
      }
    }
    return { sessionId, turns };
  } finally {
    db.close();
  }
}
