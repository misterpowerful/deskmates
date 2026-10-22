// Renders the `turn_stats` object the server attaches to speech_result /
// text_result (built by src/turnStats.js). Mirrors formatTurnStats there.
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
