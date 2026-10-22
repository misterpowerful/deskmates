import { test } from "node:test";
import assert from "node:assert/strict";
import { tokensMatch } from "../../src/auth.js";

test("empty string guess against a real token fails safely", () => {
  assert.equal(tokensMatch("", "supersecret"), false);
  assert.equal(tokensMatch("supersecret", ""), false);
});

test("non-string or undefined tokens fail safely instead of throwing", () => {
  assert.equal(tokensMatch(undefined, "supersecret"), false);
  assert.equal(tokensMatch(null, "supersecret"), false);
  assert.equal(tokensMatch(123, "supersecret"), false);
  assert.equal(tokensMatch(["supersecret"], "supersecret"), false);
  assert.equal(tokensMatch({}, "supersecret"), false);
  assert.equal(tokensMatch("supersecret", undefined), false);
});

test("very long guess does not throw and fails safely", () => {
  const longGuess = "a".repeat(1_000_000);
  assert.equal(tokensMatch(longGuess, "supersecret"), false);
  assert.equal(tokensMatch(longGuess, longGuess), true);
});
