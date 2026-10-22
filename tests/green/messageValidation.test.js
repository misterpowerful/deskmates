import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInboundMessage, KNOWN_MESSAGE_TYPES, MAX_WS_PAYLOAD_BYTES } from "../../src/messageValidation.js";

test("well-formed messages of every known type pass", () => {
  for (const type of KNOWN_MESSAGE_TYPES) {
    assert.deepEqual(validateInboundMessage({ type, id: "1", category: "greeting", mode: "chat", text: "hi", name: "x" }), { ok: true });
  }
  assert.deepEqual(validateInboundMessage({ type: "get_canned", raw: true }), { ok: true });
});

test("null or missing optional fields are left to handlers", () => {
  assert.deepEqual(validateInboundMessage({ type: "get_canned", category: null }), { ok: true });
});

test("set_personality_display_name is a known type with name and display_name fields", () => {
  assert.ok(KNOWN_MESSAGE_TYPES.has("set_personality_display_name"));
  assert.deepEqual(
    validateInboundMessage({ type: "set_personality_display_name", id: "1", name: "chet", display_name: "Chet" }),
    { ok: true },
  );
});

test("list_llms and set_llm are known types", () => {
  assert.ok(KNOWN_MESSAGE_TYPES.has("list_llms"));
  assert.ok(KNOWN_MESSAGE_TYPES.has("set_llm"));
  assert.deepEqual(validateInboundMessage({ type: "list_llms", id: "1" }), { ok: true });
  assert.deepEqual(validateInboundMessage({ type: "set_llm", id: "1", name: "sonnet-5.5" }), { ok: true });
});

test("payload cap is a few MB", () => {
  assert.ok(MAX_WS_PAYLOAD_BYTES >= 1024 * 1024 && MAX_WS_PAYLOAD_BYTES <= 16 * 1024 * 1024);
});
