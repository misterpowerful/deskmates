import { readConfig } from "./config.js";

const DEFAULT_MAX_TURNS = 20;

// Grace window a session's memory survives after its connection closes,
// keyed by ws.sessionId. Long enough to outlast the webapp's uncapped
// exponential reconnect backoff (caps at 16s/attempt — see
// webapp/src/composables/reconnect.js) through a wifi/cell handoff, app
// backgrounding, or a server restart; short enough that an abandoned
// session_id doesn't accumulate in memory forever.
export const SESSION_MEMORY_EXPIRY_MS = 5 * 60 * 1000;

// Connections that carry a session_id (the webapp) have their turns keyed
// here by that id rather than living on the ws object, so a reconnect that
// mints a new ws but sends the same session_id resumes the same
// conversation instead of starting empty. Connections with no session_id
// (the physical bot, or any client that doesn't send one) fall back to
// storing turns directly on the connection object, same as before this
// change — naturally scoped to that connection's lifetime and
// garbage-collected with the socket. Never written to disk: this is
// intentionally ephemeral either way.
const sessionsById = new Map();

function getSessionEntry(sessionId) {
  let entry = sessionsById.get(sessionId);
  if (!entry) {
    entry = { turns: [], expiryTimer: null };
    sessionsById.set(sessionId, entry);
  }
  return entry;
}

export function appendTurn(connection, role, content) {
  const { session_memory_max_turns } = readConfig();
  const maxTurns = session_memory_max_turns ?? DEFAULT_MAX_TURNS;

  const turns = connection.sessionId
    ? getSessionEntry(connection.sessionId).turns
    : (connection.sessionMemory ??= []);
  turns.push({ role, content });
  if (turns.length > maxTurns) {
    turns.splice(0, turns.length - maxTurns);
  }
}

export function getTurns(connection) {
  if (connection.sessionId) {
    return sessionsById.get(connection.sessionId)?.turns ?? [];
  }
  return connection.sessionMemory ?? [];
}

export function clearTurns(connection) {
  if (connection.sessionId) {
    const entry = getSessionEntry(connection.sessionId);
    entry.turns = [];
    entry.searchedReplies = [];
    return;
  }
  connection.sessionMemory = [];
  connection.searchedReplies = [];
}

// Replies that came from a live web search. The turns themselves go to the
// model as plain {role, content} messages, so there's nowhere to mark them;
// without this, looking back at an answer it can't see the search behind,
// the model concluded it had made the facts up and disowned them
// ("I never actually searched those", 2026-10-13). Same storage scoping as
// the turns.
export const MAX_SEARCHED_REPLIES = 5;
const MAX_SEARCHED_REPLY_CHARS = 160;

export function noteSearchedReply(connection, line) {
  const list = connection.sessionId
    ? (getSessionEntry(connection.sessionId).searchedReplies ??= [])
    : (connection.searchedReplies ??= []);
  const text = String(line ?? "").trim();
  if (!text) return;
  list.push(text.length > MAX_SEARCHED_REPLY_CHARS ? `${text.slice(0, MAX_SEARCHED_REPLY_CHARS)}...` : text);
  if (list.length > MAX_SEARCHED_REPLIES) list.splice(0, list.length - MAX_SEARCHED_REPLIES);
}

export function getSearchedReplies(connection) {
  if (connection.sessionId) {
    return sessionsById.get(connection.sessionId)?.searchedReplies ?? [];
  }
  return connection.searchedReplies ?? [];
}

// Call when a connection carrying a session_id opens. Cancels any pending
// eviction (scheduled by expireSession below on a previous connection's
// close) so a reconnect within the grace window resumes cleanly instead of
// racing an eviction that could otherwise gut memory mid-conversation.
export function resumeSession(connection) {
  const entry = connection.sessionId && sessionsById.get(connection.sessionId);
  if (entry?.expiryTimer) {
    clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
  }
}

// Call when a connection carrying a session_id closes. Rather than deleting
// its memory immediately (which would defeat reconnect continuity) or
// keeping every session_id seen since boot (an unbounded leak), schedule
// removal after graceMs — resumeSession cancels this if the same
// session_id reconnects first.
export function expireSession(connection, graceMs = SESSION_MEMORY_EXPIRY_MS) {
  const sessionId = connection.sessionId;
  if (!sessionId) return;
  const entry = sessionsById.get(sessionId);
  if (!entry) return;
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  entry.expiryTimer = setTimeout(() => {
    sessionsById.delete(sessionId);
  }, graceMs);
  entry.expiryTimer.unref?.();
}
