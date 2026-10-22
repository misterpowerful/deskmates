import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnStats, formatTurnStats } from "../../src/turnStats.js";
import { formatTurnStats as webFormat } from "../../webapp/src/composables/turnStats.js";

test("missing or hostile input yields nulls, not placeholders", () => {
  for (const bad of [undefined, null, {}, { usage: "x", timings: 5 }]) {
    const s = buildTurnStats(bad ?? undefined);
    assert.equal(s.input_tokens, null);
    assert.equal(s.cost_usd, null);
    assert.equal(s.ms_total, null);
    assert.equal(s.tts_chars, null);
  }
});

test("negative, NaN and string numbers are rejected", () => {
  const s = buildTurnStats({
    model: 7, provider: {}, usage: { input_tokens: -1, output_tokens: "5", cache_read_input_tokens: NaN },
    llmRounds: Infinity, totalElapsed: -3,
  });
  assert.equal(s.model, null);
  assert.equal(s.provider, null);
  assert.equal(s.output_tokens, null);
  assert.equal(s.cost_usd, null);
  assert.equal(s.llm_rounds, null);
  assert.equal(s.ms_total, null);
});

test("unknown model costs 0, partial usage still formats", () => {
  const s = buildTurnStats({ model: "mystery", usage: { input_tokens: 5 } });
  assert.equal(s.cost_usd, 0);
  assert.match(formatTurnStats(s), /5 in \/ \? out/);
});

test("formatters tolerate non-objects and empty stats", () => {
  for (const f of [formatTurnStats, webFormat]) {
    assert.equal(f(null), "(no turn stats)");
    assert.equal(f("x"), "(no turn stats)");
    assert.equal(f({}), "(no turn stats)");
  }
  assert.match(webFormat({ input_tokens: 1 }), /1 in \/ \? out/);
});
