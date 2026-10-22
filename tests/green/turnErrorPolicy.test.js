// Deciding whether a canned_error/speech_error is worth a visible transcript
// row, vs. staying a Log-panel-only concern — see
// webapp/src/composables/turnErrorPolicy.js and its use from session.js's
// handleJsonMessage.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSurfaceTurnError, formatTurnErrorText } from "../../webapp/src/composables/turnErrorPolicy.js";

test("a real (non-filler) outstanding request surfaces its error", () => {
  assert.equal(shouldSurfaceTurnError({ category: null, mode: "friendly", isFiller: false }), true);
});

test("a filler outstanding request stays log-only", () => {
  assert.equal(shouldSurfaceTurnError({ category: "filler", mode: "friendly", isFiller: true }), false);
});

test("an unknown/pushed id (no matching outstanding request) defaults to surfaced", () => {
  // Mirrors canned_result, which already unconditionally adds a transcript
  // turn even when outstandingRequests has no entry for the id (e.g. the
  // server's own unsolicited "pushed" pipeline_error fallback line).
  assert.equal(shouldSurfaceTurnError(undefined), true);
});

test("formats the reason the same way text_error already renders its own", () => {
  assert.equal(formatTurnErrorText("no speech detected"), "(error: no speech detected)");
});

test("falls back to a generic message when no reason was given", () => {
  assert.equal(formatTurnErrorText(undefined), "(error: request failed)");
});
