import test from "node:test";
import assert from "node:assert/strict";
import { displayModeFor, isDeepThoughtful } from "../../webapp/src/composables/effectiveMode.js";

test("malformed effective_mode values fall back", () => {
  for (const bad of [null, undefined, 5, {}, [], "", true, "x".repeat(1000)]) {
    assert.equal(displayModeFor({ effective_mode: bad }, "friendly"), "friendly");
  }
});

test("malformed messages fall back", () => {
  for (const msg of [null, undefined, "str", 7]) {
    assert.equal(displayModeFor(msg, "friendly"), "friendly");
  }
});

test("isDeepThoughtful rejects malformed turns and fillers", () => {
  for (const t of [null, undefined, "deep_thoughtful", 5, {}, { mode: "DEEP_THOUGHTFUL" }, { mode: "deep_thoughtful", is_filler: true }]) {
    assert.equal(isDeepThoughtful(t), false);
  }
});
