// Live speech-to-text for streamed uploads (2026-10-19): while the bot
// streams a question (speech_stream_start / chunks / end), the audio is also
// fed to ElevenLabs' realtime Scribe, so the transcript is ready ~0.15 s
// after the end of speech instead of the ~0.8 s a batch upload takes
// afterwards. Any failure or slowness resolves to null, and the turn falls
// back to the batch transcription of the same audio, so nothing is lost.
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { log } from "./logger.js";

const LIVE_MODEL = "scribe_v2_realtime";
export const LIVE_FINISH_TIMEOUT_MS = 1500;
let client = null;

export function defaultConnect(elevenLabs = (client ??= new ElevenLabsClient())) {
  return elevenLabs.speechToText.realtime.connect({
    modelId: LIVE_MODEL,
    audioFormat: "pcm_16000",
    sampleRate: 16000,
    // Same biasing as the batch path (see runSpeechPipeline).
    languageCode: "en",
    keyterms: ["Gatsby", "Hey Gatsby"],
  });
}

export function startLiveTranscriber({ connect = defaultConnect } = {}) {
  let conn = null;
  let failed = false;
  let closed = false;
  let ready = false;
  const pending = [];
  let resolveText;
  const finalText = new Promise((resolve) => (resolveText = resolve));
  let resolveReady;
  const readyOrFailed = new Promise((resolve) => (resolveReady = resolve));

  const fail = (why) => {
    if (failed) return;
    failed = true;
    log("live stt: falling back to batch", { reason: String(why).slice(0, 200) });
    resolveText(null);
    resolveReady();
    try {
      conn?.close();
    } catch {
      // already closed
    }
  };
  const send = (buf) => {
    try {
      conn.send({ audioBase64: buf.toString("base64") });
    } catch (err) {
      fail(err?.message ?? err);
    }
  };

  Promise.resolve()
    .then(() => connect())
    .then((c) => {
      conn = c;
      if (closed) {
        c.close();
        return;
      }
      c.on("session_started", () => {
        ready = true;
        for (const buf of pending.splice(0)) send(buf);
        resolveReady();
      });
      c.on("committed_transcript", (msg) => resolveText(typeof msg?.text === "string" ? msg.text : null));
      c.on("error", (err) => fail(err?.message ?? err?.error ?? JSON.stringify(err)));
      c.on("close", () => {
        if (!closed) fail("connection closed");
      });
    })
    .catch((err) => fail(err?.message ?? err));

  return {
    push(data) {
      if (failed || closed) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (ready) send(buf);
      else pending.push(buf);
    },
    // Commits what was sent and resolves to the transcript, or null on any
    // failure or after timeoutMs.
    async finish(timeoutMs = LIVE_FINISH_TIMEOUT_MS) {
      let timer;
      const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
      try {
        await Promise.race([readyOrFailed, timeout]);
        if (failed || !ready) return null;
        try {
          conn.commit();
        } catch (err) {
          fail(err?.message ?? err);
          return null;
        }
        const text = await Promise.race([finalText, timeout]);
        return typeof text === "string" && text.trim() ? text : null;
      } finally {
        clearTimeout(timer);
        this.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      resolveText(null);
      resolveReady();
      try {
        conn?.close();
      } catch {
        // already closed
      }
    },
  };
}
