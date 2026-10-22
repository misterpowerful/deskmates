// Exercises the running Deskmates server over a real WebSocket connection —
// auth, a get_canned round trip, an ordinary speech_request, and the
// long-term-memory "remember this" flow — so the server is testable without
// real bot hardware. Test utterances are synthesized via ElevenLabs TTS
// (real speech, real STT round trip) rather than mocked at the STT layer,
// so no test-only branches exist in the production pipeline code.
//
// Usage: npm run test-client   (server must already be running)

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { parseTaskFile } from "../src/taskFile.js";
import { isSelfImproveApproved } from "../src/config.js";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8080;
const BOT_AUTH_TOKEN = process.env.BOT_AUTH_TOKEN;

if (!BOT_AUTH_TOKEN) {
  console.error("BOT_AUTH_TOKEN is not set in .env — cannot authenticate test client.");
  process.exit(1);
}

const elevenlabs = new ElevenLabsClient();

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
}

function memoryPath(personality) {
  return path.join(ROOT, "personalities", personality, "memory.json");
}

const PENDING_DIR = path.join(ROOT, "tasks", "pending");

function pendingTaskFilenames() {
  try {
    return fs.readdirSync(PENDING_DIR).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

// Longest word over 3 letters — a rough but workable heuristic for whether
// a later spoken reply is actually referencing an earlier proposal's title
// rather than something generic ("the" "your" "task" would all be filtered).
function distinctiveWord(title) {
  const words = (title ?? "").split(/\s+/).filter((w) => w.length > 3);
  return words.sort((a, b) => b.length - a.length)[0] ?? title ?? "";
}

function readMemory(personality) {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath(personality), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function synthesizeTestAudio(text, voiceId) {
  const stream = await elevenlabs.textToSpeech.convert(voiceId, {
    text,
    modelId: "eleven_flash_v2_5",
    outputFormat: "pcm_16000",
  });
  return Buffer.from(await new Response(stream).arrayBuffer());
}

// Correlates the "header then binary" frame pairs by the request `id`.
// Terminal error types (canned_error/speech_error/error) never have a
// binary frame following them; every other type does.
function createFrameReader(ws) {
  const pending = new Map();
  let waitingHeader = null;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (waitingHeader) {
        const resolve = pending.get(waitingHeader.id);
        pending.delete(waitingHeader.id);
        resolve?.({ header: waitingHeader, audioBytes: data });
        waitingHeader = null;
      }
      return;
    }

    const header = JSON.parse(data.toString("utf8"));
    const terminal =
      header.type === "canned_error" ||
      header.type === "speech_error" ||
      header.type === "error";

    if (terminal) {
      const resolve = pending.get(header.id);
      pending.delete(header.id);
      resolve?.({ header, audioBytes: null });
      return;
    }

    waitingHeader = header;
  });

  return {
    // Default bumped from 20s: every friendly-mode speech_request now
    // carries the same full web-search + 8-custom-tool schema as
    // deep_thoughtful (TOOL_ENABLED_MODES widened to include friendly —
    // see speechPipeline.js), which carries the same worst-case latency
    // profile even on a turn that ends up calling no tool at all (observed
    // up to ~38s server-side for deep_thoughtful before this change; see
    // the step-5 comment below). Calls that still need something even
    // longer (real tool execution round trips) pass an explicit override.
    waitFor(id, timeoutMs = 45000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for response id=${id}`));
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
  };
}

function sendSpeechRequest(ws, reader, id, mode, audioBuffer, timeoutMs) {
  ws.send(JSON.stringify({ type: "speech_request", id, mode }));
  ws.send(audioBuffer, { binary: true });
  return timeoutMs === undefined ? reader.waitFor(id) : reader.waitFor(id, timeoutMs);
}

// Waits for the server to actually process the close (not just for .close()
// to return) before the caller opens the next connection — otherwise the
// next connection's upgrade request can race ahead of this one's removal
// from the server's activeConnections set and get spuriously rejected at
// the MAX_CONNECTIONS cap.
function closeAndWait(ws) {
  return new Promise((resolve) => {
    ws.once("close", resolve);
    ws.close();
  });
}

let passCount = 0;
let failCount = 0;
function report(step, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  if (ok) passCount++;
  else failCount++;
  console.log(`[${status}] ${step}${detail ? " — " + detail : ""}`);
}

async function main() {
  const config = readConfig();
  const personality = config.active_personality;
  const selfImproveApproved = isSelfImproveApproved(personality);
  const { voice_id } = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "personalities", personality, "voice-config.json"),
      "utf8",
    ),
  );

  console.log(`Connecting to ws://localhost:${PORT} as personality "${personality}"...`);
  const ws = new WebSocket(`ws://localhost:${PORT}`, {
    headers: { "X-Butterbot-Token": BOT_AUTH_TOKEN },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  console.log("Connected.\n");

  const reader = createFrameReader(ws);

  // --- Step 1: get_canned round trip (sanity check on the connection/auth) ---
  const cannedId = "c-test-1";
  ws.send(JSON.stringify({ type: "get_canned", id: cannedId, category: "filler", mode: "friendly" }));
  try {
    const { header } = await reader.waitFor(cannedId, 10000);
    report(
      "get_canned round trip",
      header.type === "canned_result" || header.type === "canned_error",
      `got type=${header.type}${header.reason ? " reason=" + header.reason : ""}`,
    );
  } catch (err) {
    report("get_canned round trip", false, err.message);
  }

  // --- Step 2: ordinary speech_request -> speech_result ---
  console.log("\nSynthesizing ordinary test utterance...");
  const ordinaryAudio = await synthesizeTestAudio("Hello there, how are you today?", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws, reader, "s-test-1", "friendly", ordinaryAudio);
    report(
      "ordinary speech_request -> speech_result",
      header.type === "speech_result",
      `got type=${header.type}${header.reason ? " reason=" + header.reason : ""}`,
    );
  } catch (err) {
    report("ordinary speech_request -> speech_result", false, err.message);
  }

  // --- Step 3: memory-trigger speech_request -> live speech_result (friendly
  // has tool access, so save_memory is offered and the turn runs live —
  // see runTextPipeline's memoryToolAvailable branch), not a canned ack ---
  console.log("\nSynthesizing memory-trigger utterance...");
  const memoryAudio = await synthesizeTestAudio("Remember that I like jazz.", voice_id);
  const beforeCount = readMemory(personality).length;

  try {
    const { header } = await sendSpeechRequest(ws, reader, "s-test-2", "friendly", memoryAudio);
    report(
      "memory-trigger speech_request -> live speech_result",
      header.type === "speech_result",
      `got type=${header.type}${header.reason ? " reason=" + header.reason : ""}`,
    );
  } catch (err) {
    report("memory-trigger speech_request -> live speech_result", false, err.message);
  }

  // --- Step 4: save_memory tool call (inside that same turn) appended a
  // fact to memory.json before the reply was returned — no background wait
  // needed, unlike the old condense-in-the-background fallback path. ---
  const afterMemory = readMemory(personality);
  const grew = afterMemory.length === beforeCount + 1;
  const newFact = afterMemory[afterMemory.length - 1];
  report(
    `personalities/${personality}/memory.json gained one entry with a non-empty fact`,
    grew && typeof newFact?.fact === "string" && newFact.fact.trim().length > 0,
    grew ? `fact="${newFact?.fact}"` : `count before=${beforeCount}, after=${afterMemory.length}`,
  );

  // --- Step 5: deep_thoughtful "suggest an improvement" -> tasks/pending/ ---
  // Explicit 45s timeout kept here (matches the new default above) as
  // documentation: the full web-search + 8-custom-tool schema attached to
  // every deep_thoughtful call adds real latency even on a turn that ends
  // up calling no tool at all — observed up to ~38s server-side. Friendly
  // now carries the identical schema (see the reader default above), so
  // this is no longer a deep_thoughtful-specific risk.
  console.log(
    `\nSynthesizing self-improvement request utterance (active personality "${personality}" is ` +
      `${selfImproveApproved ? "" : "NOT "}approved for self-improvement)...`,
  );
  const improveAudio = await synthesizeTestAudio("How could you improve yourself?", voice_id);
  const beforePending = new Set(pendingTaskFilenames());
  let proposedTitle = null;

  try {
    const { header } = await sendSpeechRequest(ws, reader, "s-test-3", "friendly", improveAudio, 45000);
    const newFile = pendingTaskFilenames().find((n) => !beforePending.has(n));

    if (selfImproveApproved) {
      let frontmatterOk = false;
      if (newFile) {
        const raw = fs.readFileSync(path.join(PENDING_DIR, newFile), "utf8");
        const { frontmatter } = parseTaskFile(raw);
        frontmatterOk =
          frontmatter.source === "gatsby-conversation" &&
          typeof frontmatter.title === "string" &&
          frontmatter.title.length > 0 &&
          !Number.isNaN(Date.parse(frontmatter.created));
        if (frontmatterOk) proposedTitle = frontmatter.title;
      }
      report(
        "deep_thoughtful self-improvement request -> new tasks/pending/ file with correct frontmatter",
        header.type === "speech_result" && newFile !== undefined && frontmatterOk,
        newFile
          ? `file=${newFile} title="${proposedTitle ?? "?"}"`
          : `no new file in tasks/pending/ (model may have judged nothing new to propose) — reply: "${header.text}"`,
      );
    } else {
      // Unapproved personality: the gate (isSelfImproveApproved, checked in
      // src/speechPipeline.js) strips propose_task out of this turn's system
      // prompt entirely, so no file should appear no matter what the model
      // replies.
      report(
        "self-improvement request from an UNAPPROVED personality -> no tasks/pending/ file written",
        header.type === "speech_result" && newFile === undefined,
        newFile ? `unexpected file=${newFile}` : `reply: "${header.text}"`,
      );
    }
  } catch (err) {
    report("deep_thoughtful self-improvement request", false, err.message);
  }

  // --- Step 6: follow-up "what have you proposed" -> surfaces it in the reply ---
  // Only meaningful for an approved personality (there's a real proposal from
  // step 5 to recall); skipped otherwise since there's nothing to surface.
  if (selfImproveApproved) {
    console.log("\nSynthesizing follow-up recall utterance...");
    const recallAudio = await synthesizeTestAudio("What have you proposed so far?", voice_id);
    try {
      const { header } = await sendSpeechRequest(ws, reader, "s-test-4", "friendly", recallAudio, 45000);
      const mentionsProposal =
        proposedTitle === null ||
        (header.text ?? "").toLowerCase().includes(distinctiveWord(proposedTitle).toLowerCase());
      report(
        "follow-up 'what have you proposed' -> surfaces the earlier proposal in the reply",
        header.type === "speech_result" && mentionsProposal,
        `reply: "${header.text}"`,
      );
    } catch (err) {
      report("follow-up 'what have you proposed' -> surfaces the earlier proposal", false, err.message);
    }
  } else {
    console.log("\nSkipping 'what have you proposed' follow-up (personality not self-improve approved).");
  }

  // --- Steps 7-10: deep_thoughtful stickiness ---
  // A fresh connection so deepThoughtfulSticky starts unset — the flag
  // lives on the connection object, so reusing `ws` (already sticky from
  // step 5 above) would make the "entry" assertion below trivially true.
  // `ws` itself is done being used after step 6, so it's closed first
  // rather than left open alongside ws2 — MAX_CONNECTIONS is 2 on the live
  // server, and this suite shouldn't need both of its own slots at once
  // when real traffic (the physical bot, the webapp) may be holding the
  // other one.
  await closeAndWait(ws);
  console.log("\nOpening a second connection to test deep_thoughtful stickiness...");
  const ws2 = new WebSocket(`ws://localhost:${PORT}`, {
    headers: { "X-Butterbot-Token": BOT_AUTH_TOKEN },
  });
  await new Promise((resolve, reject) => {
    ws2.once("open", resolve);
    ws2.once("error", reject);
  });
  const reader2 = createFrameReader(ws2);

  // The WS protocol never surfaces effectiveMode to the client (speech_result
  // only carries `text`), so reply length is the only externally-observable
  // proxy for "did this turn actually run deep_thoughtful": the personality
  // prompt caps every other mode at ~30-50 words, while deep_thoughtful is
  // explicitly open-ended ("as many sentences as the thought genuinely
  // takes"). Not airtight, but reliable in practice.
  const DEEP_THOUGHTFUL_WORD_THRESHOLD = 60;
  function wordCount(text) {
    return (text ?? "").trim().split(/\s+/).filter(Boolean).length;
  }
  function looksDeepThoughtful(text) {
    return wordCount(text) > DEEP_THOUGHTFUL_WORD_THRESHOLD;
  }

  // --- Step 7: trigger phrase engages deep_thoughtful ---
  console.log("\nSynthesizing deep_thoughtful trigger utterance...");
  const triggerAudio = await synthesizeTestAudio(
    "Think it through: what can you actually do? Give me the full picture.",
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws2, reader2, "sticky-1", "friendly", triggerAudio, 45000);
    report(
      "sticky: trigger phrase engages deep_thoughtful (long, capabilities-aware reply)",
      header.type === "speech_result" && looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words`,
    );
  } catch (err) {
    report("sticky: trigger phrase engages deep_thoughtful", false, err.message);
  }

  // --- Step 8: plain follow-up with NO trigger phrase stays deep_thoughtful ---
  console.log("\nSynthesizing plain follow-up utterance (no trigger phrase)...");
  const followupAudio = await synthesizeTestAudio("What's your favorite thing about that?", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws2, reader2, "sticky-2", "friendly", followupAudio, 45000);
    report(
      "sticky: plain follow-up (no trigger phrase) stays in deep_thoughtful",
      header.type === "speech_result" && looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words`,
    );
  } catch (err) {
    report("sticky: plain follow-up stays in deep_thoughtful", false, err.message);
  }

  // --- Step 9: explicit exit phrase drops back to the fast path ---
  console.log("\nSynthesizing exit-phrase utterance...");
  const exitAudio = await synthesizeTestAudio("Okay, that's enough thinking for now.", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws2, reader2, "sticky-3", "friendly", exitAudio);
    report(
      "sticky: explicit exit phrase itself gets an ordinary (short) reply",
      header.type === "speech_result" && !looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words`,
    );
  } catch (err) {
    report("sticky: explicit exit phrase itself gets an ordinary reply", false, err.message);
  }

  console.log("\nSynthesizing post-exit plain utterance...");
  const postExitAudio = await synthesizeTestAudio("What's the weather like?", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws2, reader2, "sticky-4", "friendly", postExitAudio);
    report(
      "sticky: next plain turn after exit is back on the fast (non-deep_thoughtful) path",
      header.type === "speech_result" && !looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words`,
    );
  } catch (err) {
    report("sticky: post-exit turn is back on the fast path", false, err.message);
  }

  // --- Step 10: mode flip to sentry_intruder mid-session is never deep_thoughtful ---
  console.log("\nRe-engaging sticky mode, then simulating a sentry_intruder mode flip...");
  const reengageAudio = await synthesizeTestAudio("Let's really think about this one.", voice_id);
  try {
    await sendSpeechRequest(ws2, reader2, "sticky-5", "friendly", reengageAudio, 45000);
  } catch (err) {
    report("sticky: re-engage before mode-flip test", false, err.message);
  }
  const intruderAudio = await synthesizeTestAudio("Who are you?", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws2, reader2, "sticky-6", "sentry_intruder", intruderAudio);
    report(
      "sticky: mode !== friendly (sentry_intruder) is never deep_thoughtful, sticky or not",
      header.type === "speech_result" && !looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words`,
    );
  } catch (err) {
    report("sticky: sentry_intruder mode flip is never deep_thoughtful", false, err.message);
  }

  await closeAndWait(ws2);

  // --- Steps 11-15: GitHub/Gmail/Calendar/web-search tools ---
  // Exercised here in plain friendly mode (TOOL_ENABLED_MODES in
  // speechPipeline.js), NOT via a deep_thoughtful trigger phrase — that's
  // the actual thing being tested: tools working on the fast/Haiku path
  // without needing to escalate. Every utterance below is deliberately
  // phrased to avoid every string in DEEP_THOUGHTFUL_TRIGGERS, and
  // looksDeepThoughtful (defined above, for the sticky tests) doubles as a
  // guard against a false pass — a tool call only "succeeding" because the
  // turn accidentally escalated to deep_thoughtful instead of proving the
  // friendly-mode gate works. Step 15 is the negative case: an
  // unrecognized person (sentry_intruder) asking for the exact same kind
  // of thing must NOT get a tool call — same TOOL_ENABLED_MODES check,
  // opposite outcome, since sentry_intruder was deliberately left out.
  //
  // A fresh connection, same reasoning as ws2 above. Steps 11-13 are
  // real-API smoke tests — they need GITHUB_PAT / GOOGLE_REFRESH_TOKEN
  // actually configured in .env to fully pass; without them the pipeline
  // still completes (executeCustomTool never throws — see src/tools/index.js
  // — the model just gets an error tool_result and says so), so these mostly
  // catch wiring bugs rather than credential problems. Steps 14-15 are the
  // ones that matter regardless of credentials.
  console.log(
    "\nOpening a third connection to test friendly-mode GitHub/Gmail/Calendar " +
      "tools (steps 11-13 need real GITHUB_PAT/GOOGLE_REFRESH_TOKEN in .env to fully pass)...",
  );
  const ws3 = new WebSocket(`ws://localhost:${PORT}`, {
    headers: { "X-Butterbot-Token": BOT_AUTH_TOKEN },
  });
  await new Promise((resolve, reject) => {
    ws3.once("open", resolve);
    ws3.once("error", reject);
  });
  const reader3 = createFrameReader(ws3);

  // --- Step 11: GitHub read tool, in plain friendly mode ---
  console.log("\nSynthesizing GitHub read-file utterance...");
  const githubAudio = await synthesizeTestAudio(
    "What does the name field say in the package.json file of my deskmates repo on GitHub?",
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws3, reader3, "tool-1", "friendly", githubAudio, 60000);
    report(
      "github_read_file (friendly mode): reply mentions the real name field from package.json",
      header.type === "speech_result" &&
        !looksDeepThoughtful(header.text) &&
        (header.text ?? "").toLowerCase().includes("deskmates"),
      `${wordCount(header.text)} words, reply: "${header.text}"`,
    );
  } catch (err) {
    report("github_read_file (friendly mode): reply mentions the real name field", false, err.message);
  }

  // --- Step 12: Gmail search tool, in plain friendly mode (content-free query, doesn't depend on real inbox contents) ---
  console.log("\nSynthesizing Gmail search utterance...");
  const gmailAudio = await synthesizeTestAudio(
    "Check my email for anything with the subject line zzz-nonexistent-test-subject-49216.",
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws3, reader3, "tool-2", "friendly", gmailAudio, 60000);
    report(
      "gmail_search (friendly mode): turn completes without a pipeline error",
      header.type === "speech_result" && !looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words, reply: "${header.text}"`,
    );
  } catch (err) {
    report("gmail_search (friendly mode): turn completes without a pipeline error", false, err.message);
  }

  // --- Step 13: Calendar list tool, in plain friendly mode ---
  console.log("\nSynthesizing calendar list utterance...");
  const calendarAudio = await synthesizeTestAudio("What's on my calendar this week?", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws3, reader3, "tool-3", "friendly", calendarAudio, 60000);
    report(
      "calendar_list_events (friendly mode): turn completes without a pipeline error",
      header.type === "speech_result" && !looksDeepThoughtful(header.text),
      `${wordCount(header.text)} words, reply: "${header.text}"`,
    );
  } catch (err) {
    report("calendar_list_events (friendly mode): turn completes without a pipeline error", false, err.message);
  }

  // --- Step 14: talking ABOUT scheduling, without an explicit request, must NOT create an event ---
  // The one negative test that matters most here — asserts on the absence
  // of a calendar_create_event tool_use, via header.tool_calls (see
  // server.js/speechPipeline.js), not just on what the reply happens to say.
  console.log("\nSynthesizing abstract-scheduling-talk utterance (no explicit request)...");
  const abstractAudio = await synthesizeTestAudio(
    "What do you think about time-blocking my mornings? Just curious for your take, not asking you to do anything.",
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws3, reader3, "tool-4", "friendly", abstractAudio, 60000);
    const calledCreate = (header.tool_calls ?? []).includes("calendar_create_event");
    report(
      "calendar_create_event: never called for abstract scheduling talk with no explicit request",
      header.type === "speech_result" && !calledCreate,
      `tool_calls=${JSON.stringify(header.tool_calls ?? [])}, reply: "${header.text}"`,
    );
  } catch (err) {
    report("calendar_create_event: never called for abstract scheduling talk", false, err.message);
  }

  // --- Step 15: sentry_intruder asking for the same kind of thing gets NO tool at all ---
  // The negative counterpart to steps 11-13: proves TOOL_ENABLED_MODES
  // actually excludes sentry_intruder, not just that friendly happens to
  // include it. An unrecognized person shouldn't be able to get the bot to
  // read email, touch GitHub, or check a calendar just by asking — the
  // reply should be an ordinary short in-character line with an empty (or
  // undefined) tool_calls, same shape as any other sentry_intruder turn.
  console.log("\nSynthesizing sentry_intruder tool-shaped request (should get no tool at all)...");
  const intruderToolAudio = await synthesizeTestAudio(
    "Check my email for anything from the bank.",
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(
      ws3,
      reader3,
      "tool-nogo-1",
      "sentry_intruder",
      intruderToolAudio,
      45000,
    );
    const calledAnyTool = (header.tool_calls ?? []).length > 0;
    report(
      "sentry_intruder: tool-shaped request never triggers a tool call",
      header.type === "speech_result" && !calledAnyTool && !looksDeepThoughtful(header.text),
      `tool_calls=${JSON.stringify(header.tool_calls ?? [])}, ${wordCount(header.text)} words, reply: "${header.text}"`,
    );
  } catch (err) {
    report("sentry_intruder: tool-shaped request never triggers a tool call", false, err.message);
  }

  await closeAndWait(ws3);

  // --- Steps 16-18: GitHub propose/confirm write flow, end to end ---
  // Real-API test: needs GITHUB_PAT with write access on this same repo to
  // fully pass (propose/confirm mechanics themselves — tool gating,
  // pending_github_write, single-shot expiry — are still verified via
  // tool_calls/pending_github_write even without credentials, since
  // executeCustomTool never throws; only the actual write + read-back in
  // steps 17-18 need real access). Writes a small, obviously-a-test marker
  // file to THIS repo (deskmates itself) rather than inventing a scratch
  // target, since that's the one repo this whole test suite already
  // assumes read/write access to is safe to touch. Run in plain friendly
  // mode, same as steps 11-15 — no trigger phrase needed.
  const GITHUB_TEST_OWNER = "misterpowerful";
  const GITHUB_TEST_REPO = "deskmates";
  const GITHUB_TEST_PATH = "logs/tool-test-marker.txt";
  const verifyMarker = `VERIFY-${Math.random().toString(36).slice(2, 10)}`;

  console.log("\nOpening a fourth connection to test the GitHub propose/confirm write flow...");
  const ws4 = new WebSocket(`ws://localhost:${PORT}`, {
    headers: { "X-Butterbot-Token": BOT_AUTH_TOKEN },
  });
  await new Promise((resolve, reject) => {
    ws4.once("open", resolve);
    ws4.once("error", reject);
  });
  const reader4 = createFrameReader(ws4);

  // --- Step 16: propose a write -> recorded, NOT executed, on this turn ---
  console.log("\nSynthesizing GitHub write-proposal utterance...");
  const proposeAudio = await synthesizeTestAudio(
    `I'd like you to update the file ${GITHUB_TEST_PATH} in my deskmates repo on GitHub so it contains exactly the text ${verifyMarker}.`,
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws4, reader4, "tool-5", "friendly", proposeAudio, 60000);
    const toolCalls = header.tool_calls ?? [];
    report(
      "github_propose_write: proposal recorded (not confirmed) this turn, pending_github_write now true",
      header.type === "speech_result" &&
        toolCalls.includes("github_propose_write") &&
        !toolCalls.includes("github_confirm_write") &&
        header.pending_github_write === true,
      `tool_calls=${JSON.stringify(toolCalls)}, pending_github_write=${header.pending_github_write}, reply: "${header.text}"`,
    );
  } catch (err) {
    report("github_propose_write: proposal recorded, not confirmed", false, err.message);
  }

  // --- Step 17: explicit confirmation -> github_confirm_write actually fires ---
  console.log("\nSynthesizing confirmation utterance...");
  const confirmAudio = await synthesizeTestAudio("Yes, go ahead and do it.", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws4, reader4, "tool-6", "friendly", confirmAudio, 60000);
    const toolCalls = header.tool_calls ?? [];
    report(
      "github_confirm_write: confirmation triggers the write, pending_github_write now false",
      header.type === "speech_result" &&
        toolCalls.includes("github_confirm_write") &&
        header.pending_github_write === false,
      `tool_calls=${JSON.stringify(toolCalls)}, pending_github_write=${header.pending_github_write}, reply: "${header.text}"`,
    );
  } catch (err) {
    report("github_confirm_write: confirmation triggers the write", false, err.message);
  }

  // --- Step 18: verify the change actually landed, via a real github_read_file ---
  console.log("\nSynthesizing verification read-back utterance...");
  const verifyAudio = await synthesizeTestAudio(
    `Read back exactly what ${GITHUB_TEST_PATH} says right now in my deskmates repo on GitHub.`,
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws4, reader4, "tool-7", "friendly", verifyAudio, 60000);
    report(
      "github write verified: read-back reply contains the marker just written",
      header.type === "speech_result" && (header.text ?? "").includes(verifyMarker),
      `reply: "${header.text}"`,
    );
  } catch (err) {
    report("github write verified: read-back contains the marker", false, err.message);
  }

  await closeAndWait(ws4);

  // --- Steps 19-21: an unconfirmed proposal expires after one turn ---
  console.log("\nOpening a fifth connection to test proposal expiry...");
  const ws5 = new WebSocket(`ws://localhost:${PORT}`, {
    headers: { "X-Butterbot-Token": BOT_AUTH_TOKEN },
  });
  await new Promise((resolve, reject) => {
    ws5.once("open", resolve);
    ws5.once("error", reject);
  });
  const reader5 = createFrameReader(ws5);

  // --- Step 19: propose again (different marker) ---
  console.log("\nSynthesizing second GitHub write-proposal utterance...");
  const expireMarker = `EXPIRE-${Math.random().toString(36).slice(2, 10)}`;
  const proposeAudio2 = await synthesizeTestAudio(
    `I'd like you to update the file ${GITHUB_TEST_PATH} in my deskmates repo on GitHub so it contains exactly the text ${expireMarker}.`,
    voice_id,
  );
  try {
    const { header } = await sendSpeechRequest(ws5, reader5, "tool-8", "friendly", proposeAudio2, 60000);
    report(
      "github_propose_write (expiry test): proposal recorded, pending_github_write now true",
      header.type === "speech_result" && header.pending_github_write === true,
      `pending_github_write=${header.pending_github_write}, reply: "${header.text}"`,
    );
  } catch (err) {
    report("github_propose_write (expiry test): proposal recorded", false, err.message);
  }

  // --- Step 20: an unrelated follow-up (no confirmation) expires the proposal ---
  console.log("\nSynthesizing unrelated follow-up utterance (no confirmation)...");
  const unrelatedAudio = await synthesizeTestAudio("What's your favorite kind of weather?", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws5, reader5, "tool-9", "friendly", unrelatedAudio, 60000);
    const toolCalls = header.tool_calls ?? [];
    report(
      "unconfirmed proposal expires after one unrelated turn (pending_github_write now false)",
      header.type === "speech_result" &&
        !toolCalls.includes("github_confirm_write") &&
        header.pending_github_write === false,
      `tool_calls=${JSON.stringify(toolCalls)}, pending_github_write=${header.pending_github_write}, reply: "${header.text}"`,
    );
  } catch (err) {
    report("unconfirmed proposal expires after one unrelated turn", false, err.message);
  }

  // --- Step 21: a later "yes" has nothing left to confirm ---
  console.log("\nSynthesizing late confirmation attempt (nothing pending)...");
  const lateConfirmAudio = await synthesizeTestAudio("Yes, do it.", voice_id);
  try {
    const { header } = await sendSpeechRequest(ws5, reader5, "tool-10", "friendly", lateConfirmAudio, 60000);
    const toolCalls = header.tool_calls ?? [];
    report(
      "a later 'yes' after expiry never triggers github_confirm_write (nothing pending to confirm)",
      header.type === "speech_result" && !toolCalls.includes("github_confirm_write"),
      `tool_calls=${JSON.stringify(toolCalls)}, reply: "${header.text}"`,
    );
  } catch (err) {
    report("a later 'yes' after expiry never triggers github_confirm_write", false, err.message);
  }

  ws5.close();

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("test-client crashed:", err);
  process.exit(1);
});
