import { timingSafeEqual } from "node:crypto";

// Plain !== on strings short-circuits at the first mismatched character,
// leaking (in principle) how many leading characters of a guess are
// correct. BOT_AUTH_TOKEN gates every conversation and transcript, so it
// gets a constant-time comparison instead.
export function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
