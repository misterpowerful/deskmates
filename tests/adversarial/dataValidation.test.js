import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskFile, validateInsights, validateMemoryFacts } from "../../src/dataValidation.js";

test("task files missing fields, fences or a body are rejected", () => {
  const bad = [
    "",
    "no frontmatter at all",
    "---\nsource: a\ncreated: 2026-01-01\n---\nbody",
    "---\nsource: a\ntitle: t\n---\nbody",
    "---\ncreated: 2026-01-01\ntitle: t\n---\nbody",
    "---\nsource: a\ncreated: yesterday-ish\ntitle: t\n---\nbody",
    "---\nsource: a\ncreated: 2026-01-01\ntitle: t\n---\n\n   \n",
  ];
  for (const raw of bad) assert.equal(validateTaskFile(raw).ok, false, JSON.stringify(raw));
});

test("non-string, NUL-containing, oversized and overlong-title task files are rejected", () => {
  assert.equal(validateTaskFile(null).ok, false);
  assert.equal(validateTaskFile(undefined).ok, false);
  assert.equal(validateTaskFile({}).ok, false);
  assert.equal(validateTaskFile("---\nsource: a\ncreated: 2026-01-01\ntitle: t\n---\nb\0").ok, false);
  assert.equal(validateTaskFile("---\nsource: a\ncreated: 2026-01-01\ntitle: t\n---\n" + "x".repeat(300_000)).ok, false);
  assert.equal(validateTaskFile(`---\nsource: a\ncreated: 2026-01-01\ntitle: ${"t".repeat(400)}\n---\nb`).ok, false);
});

test("CRLF task files validate the same as LF", () => {
  assert.equal(validateTaskFile("---\r\nsource: a\r\ncreated: 2026-01-01\r\ntitle: t\r\n---\r\nbody").ok, true);
});

test("insights: wrong container types are rejected", () => {
  for (const v of [null, undefined, {}, "x", 5, [null], [[]], ["str"], [1]]) assert.equal(validateInsights(v).ok, false);
});

test("insights: bad fields are each reported", () => {
  const res = validateInsights([{ insight: " ", sourceTags: "music", status: 3, createdAt: "nope" }]);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 4);
  assert.equal(validateInsights([{ insight: "i", sourceTags: [1], status: "approved", createdAt: "2026-01-01" }]).ok, false);
});

test("insights: a poisoned entry among good ones fails the whole file", () => {
  const good = { insight: "i", sourceTags: [], status: "approved", createdAt: "2026-01-01" };
  assert.equal(validateInsights([good, good, { ...good, insight: "" }]).ok, false);
});

test("memory facts: wrong container types are rejected", () => {
  for (const v of [null, undefined, {}, "x", 5, [null], [[]], ["str"], [1]]) assert.equal(validateMemoryFacts(v).ok, false);
});

test("memory facts: bad fields are each reported", () => {
  const res = validateMemoryFacts([{ fact: " ", tags: "music", savedAt: "nope" }]);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 3);
  assert.equal(validateMemoryFacts([{ fact: "f", tags: [1], savedAt: "2026-01-01" }]).ok, false);
});

test("memory facts: a missing tags field is allowed, but a wrong-type one is not", () => {
  assert.equal(validateMemoryFacts([{ fact: "f", savedAt: "2026-01-01" }]).ok, true);
  assert.equal(validateMemoryFacts([{ fact: "f", tags: null, savedAt: "2026-01-01" }]).ok, false);
});

test("memory facts: a poisoned entry among good ones fails the whole file", () => {
  const good = { fact: "f", tags: [], savedAt: "2026-01-01" };
  assert.equal(validateMemoryFacts([good, good, { ...good, fact: "" }]).ok, false);
});
