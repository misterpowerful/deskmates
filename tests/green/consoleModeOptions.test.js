// Structural check for adding bump_complaint as a selectable mode in the
// debug console (public/index.html's get_canned and speech_request panels).
//
// This is a markup-only change — server.js already treats `mode` as an
// opaque string for both get_canned and speech_request/text_request (no
// allowlist), so there is no src/ logic to extract or exercise. Per the
// precedent in tests/green/transcriptWrap.test.js (see TESTING-GATE.md §2
// item 8: entry-point markup with no src/ logic is covered by reading the
// shipped file directly), these tests assert on the actual <select>
// markup instead.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const consoleHtml = readFileSync(path.join(repoRoot, "public/index.html"), "utf8");

function selectOptionValues(html, selectId) {
  const selectRe = new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)<\\/select>`);
  const selectMatch = selectRe.exec(html);
  assert.ok(selectMatch, `expected to find <select id="${selectId}">`);
  const optionRe = /<option value="([^"]*)">/g;
  const values = [];
  let m;
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    values.push(m[1]);
  }
  return values;
}

test("get_canned mode dropdown offers bump_complaint alongside friendly and sentry_intruder", () => {
  const values = selectOptionValues(consoleHtml, "cannedMode");
  assert.deepEqual(values, ["friendly", "sentry_intruder", "bump_complaint"]);
});

test("speech_request mode dropdown offers bump_complaint alongside friendly and sentry_intruder", () => {
  const values = selectOptionValues(consoleHtml, "speechMode");
  assert.deepEqual(values, ["friendly", "sentry_intruder", "bump_complaint"]);
});

test("the bump_complaint option label matches its value (no display-text/value mismatch)", () => {
  for (const selectId of ["cannedMode", "speechMode"]) {
    const selectRe = new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)<\\/select>`);
    const body = selectRe.exec(consoleHtml)[1];
    assert.match(body, /<option value="bump_complaint">bump_complaint<\/option>/);
  }
});
