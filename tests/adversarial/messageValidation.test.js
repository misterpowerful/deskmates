import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInboundMessage } from "../../src/messageValidation.js";

test("non-object frames are rejected on the type path", () => {
  for (const bad of [null, 5, "str", [], [{ type: "get_canned" }], undefined]) {
    const r = validateInboundMessage(bad);
    assert.equal(r.ok, false);
    assert.equal(r.kind, "type");
  }
});

test("unknown or non-string type is rejected", () => {
  for (const type of ["nope", 7, {}, ["get_canned"], null, undefined, "__proto__"]) {
    const r = validateInboundMessage({ type });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "type");
    assert.match(r.reason, /unknown or missing "type"/);
  }
});

test("non-string fields are rejected", () => {
  for (const field of ["id", "category", "mode", "text", "name", "display_name"]) {
    for (const value of [{}, [], 5, true]) {
      const r = validateInboundMessage({ type: "text_request", [field]: value });
      assert.equal(r.ok, false);
      assert.equal(r.kind, "field");
      assert.match(r.reason, new RegExp(`"${field}" must be a string`));
    }
  }
});

test("absurdly long fields are rejected, text has a larger allowance", () => {
  assert.equal(validateInboundMessage({ type: "get_canned", category: "a".repeat(201) }).ok, false);
  assert.equal(validateInboundMessage({ type: "text_request", text: "a".repeat(20_000) }).ok, true);
  const r = validateInboundMessage({ type: "text_request", text: "a".repeat(20_001) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too long/);
});

test("set_llm's name field is still capped by the generic short-field limit", () => {
  const r = validateInboundMessage({ type: "set_llm", id: "1", name: "a".repeat(201) });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "field");
  assert.match(r.reason, /"name" is too long/);
});

test("display_name has a shorter allowance than the generic short-field limit", () => {
  const ok = validateInboundMessage({ type: "set_personality_display_name", display_name: "a".repeat(60) });
  assert.equal(ok.ok, true);
  const bad = validateInboundMessage({ type: "set_personality_display_name", display_name: "a".repeat(61) });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /too long/);
});
