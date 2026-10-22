// Decides whether a canned_error/speech_error frame is something the person
// was actually waiting on, or just a filler that never mattered to them.
//
// outstandingRequests (session.js) tags every get_canned/speech_request with
// isFiller — the same distinction pendingResponses already uses to route
// binary frames (see useAutoConversation.js's onBinaryFrame handler). A pure
// filler ("one sec…" audio, or its category simply missing) failing is a
// non-event from the person's point of view: they never knew it was coming,
// so it can stay a Log-panel-only concern. Everything else — a real
// speech_request turn, or a canned reply requested as the actual answer
// (e.g. the memory-trigger ack path in speechPipeline.js, which returns
// kind:"canned" for what is, conversationally, the turn's real reply) — was
// the thing they were waiting on, so its failure needs to be visible on the
// main screen, not just discoverable by opening the hamburger menu.
//
// `req` is whatever outstandingRequests.get(msg.id) returned — undefined for
// an id session.js never issued (e.g. the server's own unsolicited "pushed"
// fallback line). Missing req defaults to "surface it", matching how
// canned_result already unconditionally adds a transcript turn even when req
// is undefined.
export function shouldSurfaceTurnError(req) {
  return !(req?.isFiller ?? false);
}

// Mirrors text_error's existing `(error: ${msg.reason})` rendering
// (session.js's text_error handler) so a failed speech/canned turn reads the
// same way in the transcript as a failed text turn already does.
export function formatTurnErrorText(reason) {
  const text = typeof reason === "string" && reason.trim() ? reason : "request failed";
  return `(error: ${text})`;
}
