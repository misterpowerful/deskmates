// Per-turn usage summary attached to speech_result/text_result so live
// clients (debug console, webapp Log view) can show real figures without
// polling /api. Every field is derived from data the pipeline already has:
// the Anthropic response's usage object, the resolved model/provider, stage
// timings, and the length of the reply text sent to TTS. Nothing is invented
// — a missing or malformed input yields null, never a placeholder number.

import { estimateCost, estimateEquivalentCost } from "./turnLog.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function buildTurnStats({ model, provider, usage, llmRounds, webSearches, timings, totalElapsed, reply } = {}) {
  const u = usage && typeof usage === "object" ? usage : {};
  const t = timings && typeof timings === "object" ? timings : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const haveTokens = input !== null || output !== null;
  const [i, o, cr, cw] = [input ?? 0, output ?? 0, cacheRead ?? 0, cacheWrite ?? 0];
  return {
    model: typeof model === "string" ? model : null,
    provider: typeof provider === "string" ? provider : null,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    llm_rounds: num(llmRounds),
    web_searches: num(webSearches),
    // Billed estimate (0 for subscription turns) vs. API-equivalent scale.
    cost_usd: haveTokens ? estimateCost(model, i, o, provider, cr, cw) : null,
    equivalent_cost_usd: haveTokens ? estimateEquivalentCost(model, i, o, cr, cw) : null,
    // Characters sent to TTS (ElevenLabs bills by character); no dollar
    // figure since there is no price table for it.
    tts_chars: typeof reply === "string" ? reply.length : null,
    ms_stt: num(t.stt),
    ms_llm: num(t.llm),
    ms_tts: num(t.tts),
    ms_total: num(totalElapsed),
  };
}

// One-line human rendering, e.g. "haiku 1200 in / 80 out · $0.0016 · llm 640ms · total 1500ms".
export function formatTurnStats(stats) {
  if (!stats || typeof stats !== "object") return "(no turn stats)";
  const parts = [];
  if (typeof stats.model === "string") parts.push(stats.model);
  if (stats.input_tokens != null || stats.output_tokens != null) {
    parts.push(`${stats.input_tokens ?? "?"} in / ${stats.output_tokens ?? "?"} out`);
  }
  if (typeof stats.cost_usd === "number") {
    parts.push(stats.cost_usd === 0 && stats.equivalent_cost_usd
      ? `subscription (~$${stats.equivalent_cost_usd.toFixed(4)} API-equiv)`
      : `$${stats.cost_usd.toFixed(4)}`);
  }
  if (typeof stats.tts_chars === "number") parts.push(`${stats.tts_chars} tts chars`);
  if (typeof stats.ms_llm === "number") parts.push(`llm ${stats.ms_llm}ms`);
  if (typeof stats.ms_total === "number") parts.push(`total ${stats.ms_total}ms`);
  return parts.length ? parts.join(" · ") : "(no turn stats)";
}
