// Shape checks for inbound WebSocket text frames, run after JSON.parse and
// before any handler sees the message.

export const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const KNOWN_MESSAGE_TYPES = new Set([
  "get_canned",
  "speech_request",
  "speech_stream_start",
  "speech_stream_end",
  "speech_stream_cancel",
  "text_request",
  "list_personalities",
  "set_personality",
  "set_personality_display_name",
  "list_llms",
  "set_llm",
  "robot_result",
]);

const MAX_SHORT_FIELD_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;
const MAX_DISPLAY_NAME_FIELD_LENGTH = 60;
const STRING_FIELD_LIMITS = {
  id: MAX_SHORT_FIELD_LENGTH,
  category: MAX_SHORT_FIELD_LENGTH,
  mode: MAX_SHORT_FIELD_LENGTH,
  name: MAX_SHORT_FIELD_LENGTH,
  text: MAX_TEXT_LENGTH,
  display_name: MAX_DISPLAY_NAME_FIELD_LENGTH,
};

// Returns { ok: true } or { ok: false, kind: "type" | "field", reason }.
// "type" failures belong on the unknown-type error path.
export function validateInboundMessage(msg) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { ok: false, kind: "type", reason: 'unknown or missing "type": undefined' };
  }
  if (typeof msg.type !== "string" || !KNOWN_MESSAGE_TYPES.has(msg.type)) {
    return { ok: false, kind: "type", reason: `unknown or missing "type": ${JSON.stringify(msg.type)}` };
  }
  for (const [field, max] of Object.entries(STRING_FIELD_LIMITS)) {
    const value = msg[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      return { ok: false, kind: "field", reason: `"${field}" must be a string` };
    }
    if (value.length > max) {
      return { ok: false, kind: "field", reason: `"${field}" is too long (max ${max} characters)` };
    }
  }
  return { ok: true };
}
