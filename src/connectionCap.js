import { readConfig } from "./config.js";

// Protects a small VPS: every open connection holds a session-memory array,
// and during a turn, live STT/LLM/TTS calls. The physical bot, /console, and
// the mobile webapp (which also connects as client=console) all share this
// pool, so 2 was too tight. Change it deliberately via config.json's
// `max_connections`, not by guessing.
export const DEFAULT_MAX_CONNECTIONS = 4;

export function getMaxConnections(config = readConfig()) {
  const n = config?.max_connections;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_CONNECTIONS;
}

// Returns null when a new connection fits, else the 503 response to send.
export function capRejection(active, max) {
  if (active < max) return null;
  const reason = `at connection cap (${active}/${max})`;
  return {
    reason,
    response:
      "HTTP/1.1 503 Service Unavailable\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
      "Connection: close\r\n\r\n" +
      reason,
  };
}
