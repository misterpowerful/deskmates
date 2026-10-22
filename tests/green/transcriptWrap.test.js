// Structural checks for the transcript-wrapping fix (console + webapp).
//
// Neither public/index.html (a raw <script> page, not an ES module) nor a
// .vue single-file component can be `import`ed and executed under plain
// node:test — there's no jsdom/browser DOM here, and server.js/entry-point
// scripts are explicitly exempt from the coverage gate for the same reason
// (TESTING-GATE.md §2 item 8: "logic in them should live in src/"). This is
// a CSS/markup-only fix with no src/ logic to extract, so these tests read
// the actual shipped files and assert on the specific CSS rules/markup that
// make long transcript lines wrap instead of overflowing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const consoleHtml = readFileSync(path.join(repoRoot, "public/index.html"), "utf8");
const transcriptVue = readFileSync(path.join(repoRoot, "webapp/src/components/TranscriptPanel.vue"), "utf8");

// Pulls out `selector { ... }` (first match) so assertions target the right
// rule instead of just grepping the whole stylesheet.
function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const m = re.exec(source);
  assert.ok(m, `expected to find CSS rule "${selector}"`);
  return m[1];
}

test("console: #log can shrink below its content width (min-width: 0)", () => {
  const rule = cssRule(consoleHtml, "#log");
  assert.match(rule, /min-width:\s*0/);
});

test("console: .entry sets wrapping properties", () => {
  const rule = cssRule(consoleHtml, ".entry");
  assert.match(rule, /white-space:\s*pre-wrap/);
  assert.match(rule, /word-break:\s*break-word/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});

test("console: the message text span (.entry .msg) fills and shrinks within the row", () => {
  const rule = cssRule(consoleHtml, ".entry .msg");
  assert.match(rule, /flex:\s*1/);
  assert.match(rule, /min-width:\s*0/);
});

test("console: log() tags the message span with the .msg class", () => {
  const logFnMatch = /function log\(dir, cls, text, extraNode\) \{[\s\S]*?\n  \}/.exec(consoleHtml);
  assert.ok(logFnMatch, "expected to find the log() function");
  const body = logFnMatch[0];
  assert.match(body, /body\.className = "msg";/);
  assert.match(body, /body\.textContent = text;/);
});

test("webapp: .tp-body (the flex row's text column) can shrink below its content width", () => {
  const rule = cssRule(transcriptVue, ".tp-body");
  assert.match(rule, /flex:\s*1/);
  assert.match(rule, /min-width:\s*0/);
});

test("webapp: .tp-text wraps long words instead of overflowing", () => {
  const rule = cssRule(transcriptVue, ".tp-text");
  assert.match(rule, /word-break:\s*break-word/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});
