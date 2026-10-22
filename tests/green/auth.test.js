import { test } from "node:test";
import assert from "node:assert/strict";
import { tokensMatch } from "../../src/auth.js";

test("equal tokens of the same length match", () => {
  assert.equal(tokensMatch("supersecret", "supersecret"), true);
  assert.equal(tokensMatch("a", "a"), true);
});

test("same-length near-miss and different-length guess both fail", () => {
  assert.equal(tokensMatch("supersecreT", "supersecret"), false);
  assert.equal(tokensMatch("supersecre", "supersecret"), false);
  assert.equal(tokensMatch("supersecrets", "supersecret"), false);
});
