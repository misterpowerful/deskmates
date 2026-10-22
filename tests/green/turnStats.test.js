import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnStats, formatTurnStats } from "../../src/turnStats.js";
import { formatTurnStats as webFormat } from "../../webapp/src/composables/turnStats.js";

const base = {
  model: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 10, cache_creation_input_tokens: 4 },
  llmRounds: 2,
  webSearches: 1,
  timings: { stt: 10, llm: 20, tts: 30 },
  totalElapsed: 70,
  reply: "Quite so.",
};

test("buildTurnStats maps real usage, timings and tts chars", () => {
  const s = buildTurnStats(base);
  assert.equal(s.input_tokens, 1000000);
  assert.equal(s.cache_write_tokens, 4);
  assert.equal(s.llm_rounds, 2);
  assert.equal(s.tts_chars, 9);
  assert.equal(s.ms_total, 70);
  assert.ok(Math.abs(s.cost_usd - 6) < 0.001);
});

test("subscription turns bill $0 but keep API-equivalent", () => {
  const s = buildTurnStats({ ...base, provider: "claude-code" });
  assert.equal(s.cost_usd, 0);
  assert.ok(s.equivalent_cost_usd > 5);
  assert.match(formatTurnStats(s), /subscription/);
  assert.match(webFormat(s), /subscription/);
});

test("formatTurnStats renders one line", () => {
  const line = formatTurnStats(buildTurnStats(base));
  assert.match(line, /1000000 in \/ 1000000 out/);
  assert.match(line, /\$6\.0000/);
  assert.match(line, /llm 20ms/);
  assert.equal(webFormat(buildTurnStats(base)), line);
});
