// Adversarial companion to tests/green/consoleModeOptions.test.js.
//
// This is a markup-only change (see that file's header comment for why
// these are structural/text checks rather than DOM-execution tests). The
// "hostile input" angle here is the mode *value* itself: server.js treats
// `mode` as an opaque string with no allowlist for both get_canned and
// speech_request/text_request (server.js ~403-490), so a malformed value
// (wrong case, stray whitespace, a duplicate, or a typo) wouldn't crash
// anything — it would just silently fail to match any real mode server-side
// and fall through to whatever the pipeline does for an unrecognized mode.
// These tests confirm the added option can't introduce that kind of silent
// mismatch, and that the dropdowns don't accidentally expose a mode they
// explicitly aren't meant to (deep_thoughtful, which this console's mode
// selects intentionally omit today per the auto-mode comment in
// public/index.html).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const consoleHtml = readFileSync(path.join(repoRoot, "public/index.html"), "utf8");

function selectBody(html, selectId) {
  const selectRe = new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)<\\/select>`);
  const m = selectRe.exec(html);
  assert.ok(m, `expected to find <select id="${selectId}">`);
  return m[1];
}

function optionValues(body) {
  const optionRe = /<option value="([^"]*)">/g;
  const values = [];
  let m;
  while ((m = optionRe.exec(body)) !== null) values.push(m[1]);
  return values;
}

for (const selectId of ["cannedMode", "speechMode"]) {
  test(`${selectId}: bump_complaint value has no case/whitespace mismatch against the backend mode string`, () => {
    const values = optionValues(selectBody(consoleHtml, selectId));
    // An exact, case-sensitive match is required: server.js compares mode
    // strings directly, so "Bump_Complaint" or "bump_complaint " would
    // silently never match the real mode instead of erroring loudly.
    assert.ok(
      values.includes("bump_complaint"),
      `expected exactly "bump_complaint" in ${selectId}, got ${JSON.stringify(values)}`,
    );
    assert.equal(values.filter((v) => v.trim().toLowerCase() === "bump_complaint").length, 1);
  });

  test(`${selectId}: no duplicate option values`, () => {
    const values = optionValues(selectBody(consoleHtml, selectId));
    assert.equal(new Set(values).size, values.length, `duplicate option values in ${selectId}: ${JSON.stringify(values)}`);
  });

  test(`${selectId}: deep_thoughtful is still not exposed as a manually selectable mode`, () => {
    const values = optionValues(selectBody(consoleHtml, selectId));
    assert.ok(
      !values.includes("deep_thoughtful"),
      `${selectId} should not list deep_thoughtful (not reachable from this console's mode dropdown today)`,
    );
  });
}
