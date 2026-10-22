// Link to console-client connections: the debug console and the mobile
// webapp, both of which connect with `&client=console` (see WEBAPP.md's
// "Protocol / backend contract"). Mirrors robotLink.js's bot-socket
// tracking, but for the opposite side of the same ws.isConsoleClient flag —
// every currently-open console connection, not the physical robot.
//
// Used today by src/delegatedTasks.js's notifyTaskDone to push a
// task_notification frame so a delegated task finishing is visible from the
// webapp/console even when no physical bot is connected to chime about it.

import { log, logError } from "./logger.js";

const consoleSockets = new Set();

export function registerConsoleSocket(ws) {
  if (ws?.isConsoleClient) consoleSockets.add(ws);
}

export function unregisterConsoleSocket(ws) {
  consoleSockets.delete(ws);
}

// ws.readyState 1 === OPEN
function openConsoleSockets() {
  return [...consoleSockets].filter((ws) => ws.readyState === 1);
}

// Best-effort fan-out, never queued: unlike sendOrQueueBotFrame's single
// physical bot, there can be any number of console connections (or none),
// and a connection that's gone by the time a task finishes just misses the
// notification, same as the bot-queuing path does for an offline robot —
// list_tasks already covers catching up on demand. One socket throwing on
// send (already closing, etc.) is logged and skipped, not allowed to abort
// the rest of the broadcast or bubble up into the caller (notifyTaskDone,
// itself called from the worker-settling path that must never throw).
export function broadcastToConsoles(frame) {
  let payload;
  try {
    payload = JSON.stringify(frame);
  } catch (err) {
    logError("console broadcast: frame could not be serialized", { error: err?.message ?? String(err) });
    return 0;
  }

  let sent = 0;
  for (const ws of openConsoleSockets()) {
    try {
      ws.send(payload);
      sent += 1;
    } catch (err) {
      logError("console broadcast failed on one socket", { type: frame?.type, error: err?.message ?? String(err) });
    }
  }
  if (sent > 0) log("console frame broadcast", { type: frame?.type, sent });
  return sent;
}
