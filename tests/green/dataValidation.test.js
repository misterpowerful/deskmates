import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskFile, validateInsights, validateMemoryFacts } from "../../src/dataValidation.js";

const GOOD_TASK = "---\nsource: gatsby\ncreated: 2026-09-17T02:00:00Z\ntitle: Do a thing\n---\n\nBody text.\n";

test("a well-formed task file validates", () => {
  assert.deepEqual(validateTaskFile(GOOD_TASK), { ok: true, errors: [] });
});

test("a well-formed insights array validates", () => {
  const res = validateInsights([{ insight: "likes jazz", sourceTags: ["music"], status: "approved", createdAt: "2026-09-17T02:00:00Z" }]);
  assert.equal(res.ok, true);
  assert.equal(validateInsights([]).ok, true);
});

test("a well-formed memory facts array validates, with or without tags", () => {
  const res = validateMemoryFacts([
    { fact: "likes jazz", tags: ["music"], savedAt: "2026-09-17T02:00:00Z" },
    { fact: "owns a cat", savedAt: "2026-09-17T02:00:00Z" },
  ]);
  assert.equal(res.ok, true);
  assert.equal(validateMemoryFacts([]).ok, true);
});
