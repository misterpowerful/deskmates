import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocketServer } from "ws";
import { log, logError } from "./src/logger.js";
import { wrapPcmAsWav } from "./src/wav.js";
import { resolveTimezone, clientIpFromRequest } from "./src/clientTime.js";
import { getCannedResponse, lookupCannedText } from "./src/cannedResponses.js";
import { runSpeechPipeline, runTextPipeline, deepThoughtfulProvider, claudeCodeIsSubscriptionBilled, synthesizeLine } from "./src/speechPipeline.js";
import { buildTurnStats } from "./src/turnStats.js";
import { logTurn, queryTurns, dailyCosts, usageSummary } from "./src/turnLog.js";
import { getConversationHistory } from "./src/conversationHistory.js";
import { listPendingInOrder, saveQueueOrder, QueueOrderError } from "./src/queueOrder.js";
import { rejectTask, RejectTaskError } from "./src/taskQueue.js";
import {
  coverageSummary,
  coverageWarning,
  getPersonalityDisplayName,
  setPersonalityDisplayName,
} from "./src/personalityCoverage.js";
import { capRejection, getMaxConnections } from "./src/connectionCap.js";
import { tokensMatch } from "./src/auth.js";
import { validateInboundMessage, MAX_WS_PAYLOAD_BYTES } from "./src/messageValidation.js";
import { installCrashHandlers } from "./src/crashHandlers.js";
import { enqueueTurn, TurnQueueFullError } from "./src/turnQueue.js";
import {
  registerRobotSocket,
  unregisterRobotSocket,
  takeRobotCommand,
  buildRobotAnnouncementReport,
  setRobotCommandTimeoutHandler,
} from "./src/robotLink.js";
import { registerConsoleSocket, unregisterConsoleSocket } from "./src/consoleLink.js";
import { recentChanges } from "./src/changes.js";
import { readChangelog } from "./src/changelog.js";
import { readConfig, listPersonalities, setActivePersonality, LLM_CHOICES, DEFAULT_LLM, setActiveLlm } from "./src/config.js";
import { resumeSession, expireSession } from "./src/sessionMemory.js";
import { getMemorySnapshot, removeMemoryFact, removeInsight, UnknownPersonalityError } from "./src/longTermMemory.js";
import { ensureDelegatedTasksDir, reconcileOrphanedTasks, sweepRetention } from "./src/delegatedTasks.js";
import { handleTasksApi, sendTasksApiResult, readRawBody } from "./src/taskApi.js";
import { startStream, appendStreamChunk, endStream, cancelStream } from "./src/speechStream.js";
import { startLiveTranscriber } from "./src/liveStt.js";

const PORT = Number(process.env.PORT) || 8080;
const BOT_AUTH_TOKEN = process.env.BOT_AUTH_TOKEN;
const HEARTBEAT_INTERVAL_MS = 25_000;

if (!BOT_AUTH_TOKEN) {
  log("FATAL: BOT_AUTH_TOKEN is not set in .env — refusing to start.");
  process.exit(1);
}

// Not fatal — switching personalities shouldn't crash the bot — but a gap
// here means every get_canned request and canned-fallback path (including
// the pipeline_error fallback below) silently fails for this personality,
// so it needs to be visible in the logs right away rather than only
// discoverable by running `npm run check-personality` by hand.
{
  const startupWarning = coverageWarning(readConfig().active_personality);
  if (startupWarning) logError(`WARNING: ${startupWarning}`);
}

const activeConnections = new Set();

installCrashHandlers({ getContext: () => ({ activeConnections: activeConnections.size }) });

// Async task delegation (friendly mode, see CAPABILITIES.md and
// src/delegatedTasks.js): delegated-tasks/ needs to exist (chmod 700 — it
// can contain email content) before the first delegate_task call, a task
// still "running" from before this boot can only be an orphan (its worker
// died with the previous process, see reconcileOrphanedTasks), and the
// retention sweep runs once now and then hourly (TASK_RETENTION_HOURLY_MS
// below) rather than only via an external cron, so a single-process
// deployment with no cron configured still cleans up on its own.
ensureDelegatedTasksDir();
reconcileOrphanedTasks();
sweepRetention();
const TASK_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const taskRetentionSweep = setInterval(sweepRetention, TASK_RETENTION_SWEEP_INTERVAL_MS);

// JSON API backing the console's Turns and Costs tabs. Same
// BOT_AUTH_TOKEN as the WebSocket — the turn log contains full transcripts,
// so it is exactly as sensitive as the live conversation and gets the same
// gate rather than a weaker one.
function sendApiJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    // Analytics are read fresh every time; a cached page would quietly show
    // stale costs after new turns land.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

// Small JSON body reader for the one write endpoint; the queue order is a
// short list of filenames, so anything bigger is refused outright.
const MAX_API_BODY_BYTES = 64 * 1024;
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_API_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    const token =
      req.headers["x-butterbot-token"] ?? url.searchParams.get("token");
    if (!tokensMatch(token, BOT_AUTH_TOKEN)) {
      sendApiJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      // Webapp Tasks view: delegated-task queue + photo upload (src/taskApi.js).
      if (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")) {
        handleTasksApi({
          method: req.method,
          pathname: url.pathname,
          query: url.searchParams,
          readBody: () => readRawBody(req),
        })
          .then((result) => sendTasksApiResult(res, result))
          .catch((err) => {
            logError("tasks api response failed", { error: err?.message ?? String(err) });
            res.destroy();
          });
        return;
      }
      if (url.pathname === "/api/turns") {
        sendApiJson(res, 200, queryTurns({
          limit: Number(url.searchParams.get("limit")) || 100,
          offset: Number(url.searchParams.get("offset")) || 0,
          mode: url.searchParams.get("mode") || null,
        }));
        return;
      }
      if (url.pathname === "/api/conversation") {
        const sessionId = url.searchParams.get("session_id");
        if (typeof sessionId !== "string" || sessionId.trim() === "") {
          sendApiJson(res, 400, { error: "session_id is required" });
          return;
        }
        sendApiJson(res, 200, getConversationHistory({
          sessionId,
          limit: url.searchParams.get("limit"),
          since: url.searchParams.get("since"),
        }));
        return;
      }
      if (url.pathname === "/api/turns/daily") {
        sendApiJson(res, 200, dailyCosts({
          days: Number(url.searchParams.get("days")) || 30,
        }));
        return;
      }
      if (url.pathname === "/api/usage") {
        sendApiJson(res, 200, usageSummary({
          days: Number(url.searchParams.get("days")) || 7,
        }));
        return;
      }
      if (url.pathname === "/api/changes") {
        sendApiJson(res, 200, recentChanges({
          days: url.searchParams.get("days"),
        }));
        return;
      }
      if (url.pathname === "/api/changelog") {
        sendApiJson(res, 200, readChangelog({ cwd: process.cwd() }));
        return;
      }
      if (url.pathname === "/api/memory") {
        const personality =
          url.searchParams.get("personality") || readConfig().active_personality;
        try {
          sendApiJson(res, 200, getMemorySnapshot(personality));
        } catch (err) {
          if (err instanceof UnknownPersonalityError) {
            sendApiJson(res, 400, { error: err.message });
          } else {
            throw err;
          }
        }
        return;
      }
      if (url.pathname === "/api/queue" && req.method === "GET") {
        sendApiJson(res, 200, {
          tasks: listPendingInOrder(process.cwd()).map((t) => ({
            filename: t.filename,
            title: t.frontmatter.title ?? t.filename,
            created: t.frontmatter.created ?? null,
          })),
        });
        return;
      }
      if (url.pathname === "/api/queue/order" && req.method === "POST") {
        readJsonBody(req).then(
          (body) => {
            try {
              saveQueueOrder(process.cwd(), body?.order);
              sendApiJson(res, 200, { ok: true });
            } catch (err) {
              const known = err instanceof QueueOrderError;
              if (!known) log("queue order save failed", { error: err?.message ?? String(err) });
              sendApiJson(res, known ? 400 : 500, { error: known ? err.message : "save failed" });
            }
          },
          () => sendApiJson(res, 400, { error: "invalid request body" }),
        );
        return;
      }
      if (url.pathname === "/api/queue/reject" && req.method === "POST") {
        readJsonBody(req).then(
          (body) => {
            try {
              const filename = body?.filename;
              if (typeof filename !== "string" || filename === "" || path.basename(filename) !== filename) {
                sendApiJson(res, 400, { error: "filename must be a bare filename" });
                return;
              }
              if (!fs.existsSync(path.join(process.cwd(), "tasks", "pending", filename))) {
                sendApiJson(res, 400, { error: `no such pending task: ${filename}` });
                return;
              }
              const reason = body?.reason;
              if (reason !== undefined && typeof reason !== "string") {
                sendApiJson(res, 400, { error: "reason must be a string" });
                return;
              }
              rejectTask(process.cwd(), filename, reason);
              sendApiJson(res, 200, { ok: true });
            } catch (err) {
              const known = err instanceof RejectTaskError;
              if (!known) log("queue reject failed", { error: err?.message ?? String(err) });
              sendApiJson(res, known ? 400 : 500, { error: known ? err.message : "reject failed" });
            }
          },
          () => sendApiJson(res, 400, { error: "invalid request body" }),
        );
        return;
      }
      // Memory panel delete actions: `index` is the on-disk index returned
      // by getMemorySnapshot's own `index` field, not the entry's position
      // in that (newest-first-sorted) snapshot — see longTermMemory.js.
      // personality is checked against listPersonalities() (same gate
      // /api/memory itself uses via getMemorySnapshot) before it ever
      // reaches a filesystem path, so a bogus value can't be used to probe
      // or write outside personalities/.
      if (url.pathname === "/api/memory/fact" && req.method === "POST") {
        readJsonBody(req).then(
          (body) => {
            const { personality, index } = body ?? {};
            if (typeof personality !== "string" || !listPersonalities().includes(personality)) {
              sendApiJson(res, 400, { error: "personality must be a known personality" });
              return;
            }
            if (!Number.isInteger(index) || index < 0) {
              sendApiJson(res, 400, { error: "index must be a non-negative integer" });
              return;
            }
            try {
              removeMemoryFact(personality, index);
              sendApiJson(res, 200, { ok: true });
            } catch (err) {
              log("memory fact delete failed", { personality, index, error: err?.message ?? String(err) });
              sendApiJson(res, 400, { error: err?.message ?? "delete failed" });
            }
          },
          () => sendApiJson(res, 400, { error: "invalid request body" }),
        );
        return;
      }
      if (url.pathname === "/api/memory/insight" && req.method === "POST") {
        readJsonBody(req).then(
          (body) => {
            const { personality, index } = body ?? {};
            if (typeof personality !== "string" || !listPersonalities().includes(personality)) {
              sendApiJson(res, 400, { error: "personality must be a known personality" });
              return;
            }
            if (!Number.isInteger(index) || index < 0) {
              sendApiJson(res, 400, { error: "index must be a non-negative integer" });
              return;
            }
            try {
              removeInsight(personality, index);
              sendApiJson(res, 200, { ok: true });
            } catch (err) {
              log("memory insight delete failed", { personality, index, error: err?.message ?? String(err) });
              sendApiJson(res, 400, { error: err?.message ?? "delete failed" });
            }
          },
          () => sendApiJson(res, 400, { error: "invalid request body" }),
        );
        return;
      }
      sendApiJson(res, 404, { error: "not found" });
    } catch (err) {
      log("api request failed", {
        path: url.pathname,
        error: err?.message ?? String(err),
      });
      sendApiJson(res, 500, { error: "query failed" });
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Deskmates OK\n");
});

// noServer mode: we handle the 'upgrade' event ourselves so auth and the
// connection cap are enforced *before* the WebSocket handshake completes,
// letting us reject with a proper HTTP status instead of accept-then-close.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

httpServer.on("upgrade", (req, socket, head) => {
  const headerToken = req.headers["x-butterbot-token"];
  const queryToken = new URL(req.url, "http://localhost").searchParams.get(
    "token",
  );
  if (!tokensMatch(headerToken, BOT_AUTH_TOKEN) && !tokensMatch(queryToken, BOT_AUTH_TOKEN)) {
    log("auth rejected: bad or missing X-Butterbot-Token/token", {
      remote: req.socket.remoteAddress,
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const maxConnections = getMaxConnections();
  const rejection = capRejection(activeConnections.size, maxConnections);
  if (rejection) {
    log("connection rejected: at cap", { max: maxConnections });
    socket.write(rejection.response);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  activeConnections.add(ws);
  ws.isAlive = true;
  ws.pendingAudioRequest = null;
  const connUrl = new URL(req.url, "http://localhost");
  ws.isConsoleClient = connUrl.searchParams.get("client") === "console";
  // Gatsby's clock: resolved once per connection, so a reconnect from a new
  // network (home WiFi -> phone hotspot) re-derives the zone automatically.
  ws.timezone = resolveTimezone(clientIpFromRequest(req), readConfig());
  registerRobotSocket(ws);
  registerConsoleSocket(ws);
  // The web client mints a stable per-browser session_id and has been sending
  // it since it was written; nothing read it until the turn log needed a way
  // to group turns into conversations.
  ws.sessionId = connUrl.searchParams.get("session_id") ?? null;
  // Resumes this session's memory (if any survived from a prior connection
  // that hasn't yet hit its expiry grace window) and cancels that pending
  // eviction — see src/sessionMemory.js.
  resumeSession(ws);
  log("connection open", {
    remote: req.socket.remoteAddress,
    activeConnections: activeConnections.size,
    isConsoleClient: ws.isConsoleClient,
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(ws, data);
      return;
    }
    handleTextMessage(ws, data);
  });

  ws.on("close", () => {
    activeConnections.delete(ws);
    unregisterRobotSocket(ws);
    unregisterConsoleSocket(ws);
    // Doesn't wipe this session's memory immediately — schedules it for
    // later so a reconnect (e.g. the webapp's auto-reconnect) resumes the
    // same conversation. See src/sessionMemory.js.
    expireSession(ws);
    log("connection closed", { activeConnections: activeConnections.size });
  });

  ws.on("error", (err) => {
    log("connection error", { message: err.message });
  });
});

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// Console-only debug aid: the debug console feeds outgoing audio straight
// into a browser <audio> element, which needs a container/header to infer
// format — raw PCM alone won't play. The real bot pipes raw PCM straight to
// I2S and has no such need, so this is applied only when ws.isConsoleClient.
// Pure function: PCM buffer in, 44-byte-header WAV buffer out. Easy to find
// and remove later if the console stops needing it.
// Prepares an outgoing audio frame for a given connection: WAV-wraps it for
// console clients so the browser <audio> element can play it, and leaves it
// byte-identical for real bot connections. `raw` opts a specific request out
// of WAV-wrapping even on a console connection — used by the console's auto
// conversation mode, which decodes raw PCM straight into an AudioBuffer and
// has no use for the container; the manual/single-shot testing panel never
// sets this, so it keeps getting WAV frames for its <audio> element.
function prepareOutgoingAudio(ws, pcmBuffer, raw = false) {
  return ws.isConsoleClient && !raw ? wrapPcmAsWav(pcmBuffer) : pcmBuffer;
}

function handleTextMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString("utf8"));
  } catch {
    log("dropping connection: unparseable frame");
    ws.close();
    return;
  }

  const id = typeof msg?.id === "string" ? msg.id : null;

  const check = validateInboundMessage(msg);
  if (!check.ok) {
    log("rejecting malformed message", { reason: check.reason });
    sendJson(ws, { type: "error", id, reason: check.reason });
    return;
  }

  switch (msg?.type) {
    case "get_canned":
      handleGetCanned(ws, msg, id);
      return;
    case "speech_request":
      handleSpeechRequestHeader(ws, msg, id);
      return;
    case "speech_stream_start":
      handleSpeechStreamStart(ws, msg, id);
      return;
    case "speech_stream_end":
      handleSpeechStreamEnd(ws, id);
      return;
    case "speech_stream_cancel":
      {
        const live = ws.audioStream?.live;
        if (cancelStream(ws, id)) {
          live?.close();
          log("speech stream cancelled", { id });
        }
      }
      return;
    case "text_request":
      handleTextRequest(ws, msg, id);
      return;
    case "list_personalities":
      handleListPersonalities(ws, id);
      return;
    case "set_personality":
      handleSetPersonality(ws, msg, id);
      return;
    case "set_personality_display_name":
      handleSetPersonalityDisplayName(ws, msg, id);
      return;
    case "list_llms":
      handleListLlms(ws, id);
      return;
    case "set_llm":
      handleSetLlm(ws, msg, id);
      return;
    case "robot_result":
      handleRobotResult(ws, msg, id);
      return;
    default:
      log("unknown message type", { type: msg?.type });
      sendJson(ws, {
        type: "error",
        id,
        reason: `unknown or missing "type": ${JSON.stringify(msg?.type)}`,
      });
  }
}

function handleBinaryMessage(ws, data) {
  // Audio for an open streamed upload (speech_stream_start) goes there, and
  // to its live transcriber.
  const live = ws.audioStream?.live;
  if (appendStreamChunk(ws, data)) {
    live?.push(data);
    return;
  }

  const pending = ws.pendingAudioRequest;
  ws.pendingAudioRequest = null;

  if (!pending) {
    log("dropping unexpected binary frame (no pending speech_request)");
    return;
  }

  queueTurn(ws, pending.id, () =>
    runSpeechRequest(ws, pending.id, pending.mode, data, pending.raw),
  );
}

// Runs a speech/text turn strictly after earlier turns on this connection.
// Canned and admin messages deliberately bypass this.
// The robot finished a command Gatsby gave it (robot_find_me). Have him react in one line and
// push that to the bot as an "announce" frame, which it plays once it's idle.
function handleRobotResult(ws, msg, id) {
  const entry = id ? takeRobotCommand(id) : null;
  log("robot result", {
    id,
    action: msg.action,
    outcome: msg.outcome,
    owner_recognized: Boolean(msg.owner_recognized),
    owner_enrolled: Boolean(msg.owner_enrolled),
    expected: Boolean(entry),
  });
  if (!entry) return;
  queueTurn(ws, `announce-${id}`, () => runRobotAnnouncement(ws, id, buildRobotAnnouncementReport(msg)));
}

// A robot_find_me command that never got a robot_result in time (dead wifi,
// crash mid-sweep). The pending entry is already gone by the time this
// fires (src/robotLink.js clears it); just tell whoever's waiting instead of
// leaving them with silence after "I'm on my way!".
setRobotCommandTimeoutHandler((ws, id, entry) => {
  if (!ws || ws.readyState !== 1) return;
  const report = buildRobotAnnouncementReport({ outcome: "timeout", action: entry.action });
  queueTurn(ws, `announce-${id}`, () => runRobotAnnouncement(ws, id, report));
});

async function runRobotAnnouncement(ws, id, report) {
  const timings = {};
  ws.robotAnnouncing = true;
  let result;
  try {
    result = await runTextPipeline(ws, "friendly", report, timings);
  } finally {
    ws.robotAnnouncing = false;
  }
  if (result.kind === "canned" || !result.line) return;
  const audio = await synthesizeLine(result.line, result.effectiveMode);
  const outgoing = prepareOutgoingAudio(ws, audio, true);
  sendJson(ws, { type: "announce", id: `a-${id}`, text: result.line, bytes: outgoing.length });
  ws.send(outgoing, { binary: true });
  log("robot announcement", { id, line: result.line, bytes: outgoing.length, timings });
}

function queueTurn(ws, id, fn) {
  enqueueTurn(ws, fn).catch((err) => {
    if (err instanceof TurnQueueFullError) {
      log("turn queue full, rejecting", { id });
      sendJson(ws, { type: "error", id, reason: "busy, try again" });
    } else {
      log("turn failed", { id, error: err?.message });
    }
  });
}

function handleGetCanned(ws, msg, id) {
  const { category, mode } = msg;
  if (!id || !category || !mode) {
    sendJson(ws, {
      type: "error",
      id,
      reason: "get_canned requires id, category, and mode",
    });
    return;
  }

  const t0 = Date.now();
  const result = getCannedResponse(mode, category);
  const elapsed = Date.now() - t0;

  if (!result.ok) {
    log("get_canned miss", { id, mode, category, elapsed, reason: result.reason });
    sendJson(ws, { type: "canned_error", id, reason: result.reason });
    return;
  }

  const raw = !!msg.raw;
  const outgoing = prepareOutgoingAudio(ws, result.bytes, raw);

  log("get_canned hit", {
    id,
    mode,
    category,
    lineId: result.lineId,
    bytes: outgoing.length,
    elapsed,
  });
  sendJson(ws, {
    type: "canned_result",
    id,
    line_id: result.lineId,
    bytes: outgoing.length,
    raw,
    text: lookupCannedText(category, result.lineId),
  });
  ws.send(outgoing, { binary: true });
}

function handleSpeechRequestHeader(ws, msg, id) {
  const { mode } = msg;
  if (!id || !mode) {
    sendJson(ws, {
      type: "error",
      id,
      reason: "speech_request requires id and mode",
    });
    return;
  }
  // The binary audio frame is expected to follow immediately.
  const overwritten = ws.pendingAudioRequest;
  if (overwritten) {
    log("warning: speech_request header overwrote one still awaiting audio", {
      overwrittenId: overwritten.id,
      newId: id,
    });
    sendJson(ws, {
      type: "error",
      id: overwritten.id,
      reason: "superseded by a new speech_request before its audio arrived",
    });
  }
  ws.pendingAudioRequest = { id, mode, raw: !!msg.raw };
  // A one-shot upload supersedes any stream the bot gave up on (it falls
  // back to this path when streaming fails), so its binary frame isn't
  // swallowed by the stale stream.
  if (cancelStream(ws)) log("speech stream dropped for a one-shot speech_request", { id });
}

// Streamed upload (src/speechStream.js): audio arrives while the person is
// still talking; on speech_stream_end the turn runs exactly like a one-shot
// speech_request whose audio has just landed.
function handleSpeechStreamStart(ws, msg, id) {
  const { mode } = msg;
  if (!id || !mode) {
    sendJson(ws, { type: "error", id, reason: "speech_stream_start requires id and mode" });
    return;
  }
  ws.audioStream?.live?.close();
  const replaced = startStream(ws, { id, mode, raw: !!msg.raw });
  if (replaced) log("warning: speech_stream_start replaced a stream that never ended", { replacedId: replaced, newId: id });
  ws.audioStream.live = startLiveTranscriber();
}

function handleSpeechStreamEnd(ws, id) {
  const live = ws.audioStream?.id === id ? ws.audioStream.live : null;
  const result = endStream(ws, id);
  if (!result.ok) {
    live?.close();
    log("speech stream end rejected", { id, reason: result.reason });
    sendJson(ws, { type: "error", id, reason: result.reason });
    return;
  }
  log("speech stream complete", { id, bytes: result.audio.length });
  queueTurn(ws, id, async () => {
    const liveTranscript = live ? await live.finish() : null;
    return runSpeechRequest(ws, id, result.mode, result.audio, result.raw, { liveTranscript });
  });
}

// Console-only debug aid: lets the debug console test the Claude leg of the
// pipeline with a typed transcript instead of recorded audio — no STT-in, no
// TTS-out, no binary frame either direction. Gated on ws.isConsoleClient the
// same way list_personalities/set_personality are; the real bot has no code
// path that ever sends this.
function handleTextRequest(ws, msg, id) {
  if (!ws.isConsoleClient) {
    sendJson(ws, { type: "error", id, reason: "text_request is console-only" });
    return;
  }
  const { mode, text } = msg;
  if (!id || !mode || typeof text !== "string" || !text) {
    sendJson(ws, {
      type: "error",
      id,
      reason: "text_request requires id, mode, and a non-empty text string",
    });
    return;
  }
  queueTurn(ws, id, () => runTextRequest(ws, id, mode, text));
}

// Admin-only actions (personality switching), same as the console's WAV
// wrapping: gated on ws.isConsoleClient rather than a separate auth tier,
// since only the debug console has any UI to drive them from.
function handleListPersonalities(ws, id) {
  if (!ws.isConsoleClient) {
    sendJson(ws, { type: "error", id, reason: "list_personalities is console-only" });
    return;
  }
  try {
    const personalities = listPersonalities();
    const { active_personality } = readConfig();
    const coverage = Object.fromEntries(personalities.map((name) => [name, coverageSummary(name)]));
    // display_names lets clients label each entry in the personality list
    // without re-deriving a name from the slug themselves (see
    // getPersonalityDisplayName — falls back to the slug derivation itself
    // for a personality with no explicit display_name set yet).
    const displayNames = Object.fromEntries(personalities.map((name) => [name, getPersonalityDisplayName(name)]));
    sendJson(ws, {
      type: "personalities_result",
      id,
      personalities,
      active: active_personality,
      coverage,
      display_names: displayNames,
    });
  } catch (err) {
    log("list_personalities failed", { error: err?.message ?? String(err) });
    sendJson(ws, { type: "error", id, reason: err?.message ?? "failed to list personalities" });
  }
}

function handleSetPersonality(ws, msg, id) {
  if (!ws.isConsoleClient) {
    sendJson(ws, { type: "error", id, reason: "set_personality is console-only" });
    return;
  }
  const { name } = msg;
  if (!name) {
    sendJson(ws, { type: "error", id, reason: "set_personality requires name" });
    return;
  }
  try {
    const config = setActivePersonality(name);
    log("active_personality changed", { active_personality: config.active_personality });
    const switchWarning = coverageWarning(config.active_personality);
    if (switchWarning) logError(`WARNING: ${switchWarning}`);
    sendJson(ws, { type: "personality_result", id, active_personality: config.active_personality });
  } catch (err) {
    log("set_personality failed", { name, error: err?.message ?? String(err) });
    sendJson(ws, { type: "error", id, reason: err?.message ?? "failed to set personality" });
  }
}

// Conversation-model switcher (Haiku <-> Sonnet 5.5 without thinking). Same
// console-only gate and validate-then-write shape as the personality handlers.
function handleListLlms(ws, id) {
  if (!ws.isConsoleClient) {
    sendJson(ws, { type: "error", id, reason: "list_llms is console-only" });
    return;
  }
  const { active_llm } = readConfig();
  const active = Object.hasOwn(LLM_CHOICES, active_llm) ? active_llm : DEFAULT_LLM;
  const options = Object.entries(LLM_CHOICES).map(([value, c]) => ({ value, label: c.label }));
  sendJson(ws, { type: "llms_result", id, options, active });
}

function handleSetLlm(ws, msg, id) {
  if (!ws.isConsoleClient) {
    sendJson(ws, { type: "error", id, reason: "set_llm is console-only" });
    return;
  }
  const { name } = msg;
  if (!name) {
    sendJson(ws, { type: "error", id, reason: "set_llm requires name" });
    return;
  }
  try {
    const config = setActiveLlm(name);
    log("active_llm changed", { active_llm: config.active_llm });
    sendJson(ws, { type: "llm_result", id, active: config.active_llm });
  } catch (err) {
    log("set_llm failed", { name, error: err?.message ?? String(err) });
    sendJson(ws, { type: "error", id, reason: err?.message ?? "failed to set llm" });
  }
}

// Renames a personality's friendly display_name without switching which one
// is active. Same console-only gate and validate-then-write shape as
// handleSetPersonality above.
function handleSetPersonalityDisplayName(ws, msg, id) {
  if (!ws.isConsoleClient) {
    sendJson(ws, { type: "error", id, reason: "set_personality_display_name is console-only" });
    return;
  }
  const { name, display_name } = msg;
  if (!name || typeof display_name !== "string" || !display_name.trim()) {
    sendJson(ws, {
      type: "error",
      id,
      reason: "set_personality_display_name requires name and a non-empty display_name",
    });
    return;
  }
  const known = listPersonalities();
  if (!known.includes(name)) {
    sendJson(ws, { type: "error", id, reason: `unknown personality "${name}" (known: ${known.join(", ")})` });
    return;
  }
  try {
    const displayName = setPersonalityDisplayName(name, display_name);
    log("personality display_name changed", { name, display_name: displayName });
    sendJson(ws, { type: "personality_display_name_result", id, name, display_name: displayName });
  } catch (err) {
    log("set_personality_display_name failed", { name, error: err?.message ?? String(err) });
    sendJson(ws, { type: "error", id, reason: err?.message ?? "failed to set display name" });
  }
}

async function runSpeechRequest(ws, id, mode, audioData, raw = false, { liveTranscript = null } = {}) {
  const timings = {};
  const t0 = Date.now();
  // Once per turn: the first tool call tells the bot to fill the wait now.
  let progressSent = false;
  ws.onTurnProgress = (progress) => {
    if (progressSent) return;
    progressSent = true;
    sendJson(ws, { type: "turn_progress", id, ...progress });
  };
  try {
    const audioBuffer = Buffer.isBuffer(audioData)
      ? audioData
      : Buffer.from(audioData);
    const result = await runSpeechPipeline(ws, mode, audioBuffer, timings, undefined, undefined, { liveTranscript });
    const totalElapsed = Date.now() - t0;

    // Silence/noise-only transcript: nothing broke, so no canned failure line
    // and no turn-log entry (turnLog rows require a real model/line).
    if (result.kind === "no_speech") {
      log("speech_request no speech", { id, mode, transcript: result.transcript, timings, totalElapsed });
      sendJson(ws, { type: "speech_error", id, reason: "no speech detected" });
      return;
    }

    // A "remember this"-style utterance short-circuits to a canned ack
    // instead of a live-synthesized reply — same wire shape as get_canned,
    // just triggered by a speech_request instead of an explicit request.
    if (result.kind === "canned") {
      if (!result.ok) {
        log("speech_request memory-trigger ack miss", {
          id,
          mode,
          effectiveMode: result.effectiveMode,
          transcript: result.transcript,
          reason: result.reason,
          timings,
          totalElapsed,
        });
        sendJson(ws, { type: "canned_error", id, reason: result.reason });
        return;
      }
      const outgoing = prepareOutgoingAudio(ws, result.bytes, raw);
      log("speech_request memory-trigger ack", {
        id,
        mode,
        effectiveMode: result.effectiveMode,
        transcript: result.transcript,
        lineId: result.lineId,
        bytes: outgoing.length,
        timings,
        totalElapsed,
      });
      sendJson(ws, {
        type: "canned_result",
        id,
        line_id: result.lineId,
        bytes: outgoing.length,
        raw,
        text: lookupCannedText(result.category, result.lineId),
      });
      ws.send(outgoing, { binary: true });
      return;
    }

    const { transcript, effectiveMode, line, audio, toolCalls, pendingGithubWrite } = result;
    const outgoing = prepareOutgoingAudio(ws, audio, raw);
    log("speech_request ok", {
      id,
      mode,
      effectiveMode,
      transcript,
      line,
      model: result.model,
      provider: result.provider,
      toolCalls,
      pendingGithubWrite,
      bytes: outgoing.length,
      timings,
      totalElapsed,
    });

    sendJson(ws, {
      type: "speech_result",
      id,
      bytes: outgoing.length,
      raw,
      text: line,
      user_text: transcript,
      effective_mode: effectiveMode,
      turn_stats: buildTurnStats({ ...result, reply: line, timings, totalElapsed }),
      // Both only present for deep_thoughtful turns (JSON.stringify drops
      // the key entirely when undefined) — let test-client.js (and any
      // other consumer) verify which tools fired and whether a GitHub write
      // proposal is still pending, without guessing from reply text.
      tool_calls: toolCalls,
      pending_github_write: pendingGithubWrite,
      // The personality that actually produced this turn, plus its sourced
      // display name — clients don't need to derive a name from the slug.
      personality: result.personality,
      personality_display_name: getPersonalityDisplayName(result.personality),
    });
    ws.send(outgoing, { binary: true });
    logTurn({
      sessionId: ws.sessionId,
      personality: result.personality,
      requestedMode: mode,
      effectiveMode,
      deepReason: result.deepReason,
      model: result.model,
      provider: result.provider,
      kind: "speech",
      channel: "speech",
      transcript,
      reply: line,
      usage: result.usage,
      llmRounds: result.llmRounds,
      webSearches: result.webSearches,
      toolCalls,
      timings,
      totalElapsed,
      ok: true,
    });
  } catch (err) {
    const totalElapsed = Date.now() - t0;
    log("speech_request failed", {
      id,
      mode,
      timings,
      totalElapsed,
      error: err?.message ?? String(err),
    });

    sendJson(ws, { type: "speech_error", id, reason: err?.message ?? "pipeline error" });
    logTurn({
      sessionId: ws.sessionId,
      requestedMode: mode,
      kind: "speech",
      channel: "speech",
      timings,
      totalElapsed,
      ok: false,
      error: err?.message ?? String(err),
    });

    // Push an unsolicited canned fallback line so the bot always has
    // something to play even when the real pipeline breaks.
    const pushedId = `pushed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fallbackCategory = "pipeline_error";
    const fallback = getCannedResponse(mode, fallbackCategory);
    if (fallback.ok) {
      const outgoingFallback = prepareOutgoingAudio(ws, fallback.bytes, raw);
      sendJson(ws, {
        type: "canned_result",
        id: pushedId,
        line_id: fallback.lineId,
        bytes: outgoingFallback.length,
        raw,
        text: lookupCannedText(fallbackCategory, fallback.lineId),
      });
      ws.send(outgoingFallback, { binary: true });
    } else {
      sendJson(ws, { type: "canned_error", id: pushedId, reason: fallback.reason });
    }
  }
}

async function runTextRequest(ws, id, mode, text) {
  const timings = {};
  const t0 = Date.now();
  try {
    const result = await runTextPipeline(ws, mode, text, timings);
    const totalElapsed = Date.now() - t0;

    if (result.kind === "canned") {
      if (!result.ok) {
        log("text_request memory-trigger ack miss", {
          id,
          mode,
          effectiveMode: result.effectiveMode,
          transcript: result.transcript,
          reason: result.reason,
          timings,
          totalElapsed,
        });
        sendJson(ws, { type: "text_error", id, reason: result.reason });
        return;
      }
      const replyText = lookupCannedText(result.category, result.lineId) ?? "";
      log("text_request memory-trigger ack", {
        id,
        mode,
        effectiveMode: result.effectiveMode,
        transcript: result.transcript,
        lineId: result.lineId,
        timings,
        totalElapsed,
      });
      sendJson(ws, { type: "text_result", id, text: replyText });
      return;
    }

    const { effectiveMode, line, toolCalls, pendingGithubWrite } = result;
    log("text_request ok", {
      id,
      mode,
      effectiveMode,
      transcript: text,
      line,
      model: result.model,
      provider: result.provider,
      toolCalls,
      pendingGithubWrite,
      timings,
      totalElapsed,
    });
    sendJson(ws, {
      type: "text_result",
      id,
      text: line,
      effective_mode: effectiveMode,
      turn_stats: buildTurnStats({ ...result, reply: line, timings, totalElapsed }),
      tool_calls: toolCalls,
      pending_github_write: pendingGithubWrite,
      personality: result.personality,
      personality_display_name: getPersonalityDisplayName(result.personality),
    });
    logTurn({
      sessionId: ws.sessionId,
      personality: result.personality,
      requestedMode: mode,
      effectiveMode,
      deepReason: result.deepReason,
      model: result.model,
      provider: result.provider,
      kind: "text",
      channel: "text",
      transcript: result.transcript ?? text,
      reply: line,
      usage: result.usage,
      llmRounds: result.llmRounds,
      webSearches: result.webSearches,
      toolCalls,
      timings,
      totalElapsed,
      ok: true,
    });
  } catch (err) {
    const totalElapsed = Date.now() - t0;
    log("text_request failed", {
      id,
      mode,
      timings,
      totalElapsed,
      error: err?.message ?? String(err),
    });
    sendJson(ws, { type: "text_error", id, reason: err?.message ?? "pipeline error" });
    logTurn({
      sessionId: ws.sessionId,
      requestedMode: mode,
      kind: "text",
      channel: "text",
      transcript: text,
      timings,
      totalElapsed,
      ok: false,
      error: err?.message ?? String(err),
    });
  }
}

// Server-initiated keepalive: ping every connection on an interval and drop
// any that didn't answer the previous ping — this also self-heals the
// connection-cap accounting if a bot vanishes without a clean close.
const heartbeat = setInterval(() => {
  for (const ws of activeConnections) {
    if (ws.isAlive === false) {
      log("terminating unresponsive connection");
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

httpServer.listen(PORT, () => {
  log(`Deskmates listening on port ${PORT}`);
  // Resolved provider per mode, logged once at boot so "which provider is
  // this deployment actually running" is answerable from the journal
  // without reading .env or guessing from turn behavior. friendly is
  // hardcoded "api" — see the scope note on TOOL_ENABLED_MODES in
  // speechPipeline.js, it's never affected by DEEP_THOUGHTFUL_PROVIDER.
  const dtProvider = deepThoughtfulProvider();
  log("provider resolution", {
    friendly: "api",
    deep_thoughtful: dtProvider,
    claude_code_oauth_token_present: claudeCodeIsSubscriptionBilled(),
  });
  if (dtProvider === "claude-code" && !claudeCodeIsSubscriptionBilled()) {
    log(
      "WARNING: DEEP_THOUGHTFUL_PROVIDER=claude-code but CLAUDE_CODE_OAUTH_TOKEN is not set — deep_thoughtful turns will run through the Claude Agent SDK but authenticate with ANTHROPIC_API_KEY, so they are still metered API spend, not subscription-covered",
    );
  }
});

function shutdown() {
  log("shutting down");
  clearInterval(heartbeat);
  clearInterval(taskRetentionSweep);
  for (const ws of activeConnections) ws.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
