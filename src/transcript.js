// A lone bracketed/parenthesised tag such as "(silence)" or "[background noise]".
const TAG_ONLY = /^(?:\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|\*[^*]*\*)$/;
// Nothing but punctuation, symbols and whitespace (no letters or digits).
const NO_WORDS = /^[^\p{L}\p{N}]*$/u;

// True when STT returned nothing worth sending to Claude: null/empty/whitespace,
// punctuation only, or a single non-speech tag. Real short words ("no", "ok")
// are never flagged.
export function isBlankTranscript(text) {
  if (typeof text !== "string") return true;
  const t = text.trim();
  return NO_WORDS.test(t) || TAG_ONLY.test(t);
}

// The speech pipeline's short-circuit result for a blank transcript, or null.
export function noSpeechResult(transcript) {
  return isBlankTranscript(transcript) ? { kind: "no_speech", transcript } : null;
}
