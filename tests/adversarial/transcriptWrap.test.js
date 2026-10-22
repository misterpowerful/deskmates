// Adversarial companion to tests/green/transcriptWrap.test.js.
//
// This is a CSS/markup-only fix (see that file's header comment for why
// these are structural/text checks rather than DOM-execution tests). The
// "hostile input" angle here is transcript text itself: user speech or a
// deep_thoughtful reply is attacker-adjacent free text (could contain
// markup, be pathologically long with no whitespace, or contain control
// chars). These tests confirm the wrapping fix degrades safely for that
// text rather than being bypassed or reintroducing an injection risk:
//   - the fix must be unconditional (not gated on message length/shape),
//   - the console must keep using textContent, never innerHTML, for the
//     message body, so hostile markup can never break out of the row,
//   - the webapp must keep using {{ }} text interpolation, never v-html,
//     for the same reason,
//   - no more-specific/later rule should silently re-disable wrapping
//     (e.g. white-space: nowrap or a clipping overflow: hidden) for the
//     exact selectors the fix relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const consoleHtml = readFileSync(path.join(repoRoot, "public/index.html"), "utf8");
const transcriptVue = readFileSync(path.join(repoRoot, "webapp/src/components/TranscriptPanel.vue"), "utf8");

test("console: message rendering never uses innerHTML (hostile markup in a transcript line can't break out of the row)", () => {
  const logFnMatch = /function log\(dir, cls, text, extraNode\) \{[\s\S]*?\n  \}/.exec(consoleHtml);
  assert.ok(logFnMatch, "expected to find the log() function");
  assert.doesNotMatch(logFnMatch[0], /\.innerHTML/);
});

test("console: the .msg class is assigned unconditionally, not gated on the text content", () => {
  const logFnMatch = /function log\(dir, cls, text, extraNode\) \{[\s\S]*?\n  \}/.exec(consoleHtml);
  assert.ok(logFnMatch, "expected to find the log() function");
  const body = logFnMatch[0];
  const classLine = body.indexOf('body.className = "msg";');
  assert.notEqual(classLine, -1, "className assignment missing");
  // No conditional keyword appears between the span's creation and the
  // className assignment — i.e. it isn't wrapped in an `if` that some
  // pathological text/dir/cls combination could skip.
  const createLine = body.indexOf("const body = document.createElement");
  const between = body.slice(createLine, classLine);
  assert.doesNotMatch(between, /\bif\s*\(/);
});

test("console: an oversized, whitespace-free line is still coverable by the wrap CSS (no unset min-width slipped back in)", () => {
  // Guards against a future edit re-adding `.entry .msg { min-width: auto }`
  // (or removing it), which would silently regress overflow for exactly the
  // pathological case (one giant unbreakable token, e.g. deep_thoughtful
  // output with no spaces) this fix targets.
  const msgRule = /\.entry \.msg\s*\{([^}]*)\}/.exec(consoleHtml);
  assert.ok(msgRule, "expected .entry .msg rule");
  assert.doesNotMatch(msgRule[1], /min-width:\s*auto/);
  assert.doesNotMatch(consoleHtml, /\.entry(\s*\.msg)?\s*\{[^}]*white-space:\s*nowrap/);
});

test("console: #log doesn't clip overflow instead of wrapping it", () => {
  const logRule = /#log\s*\{([^}]*)\}/.exec(consoleHtml);
  assert.ok(logRule, "expected #log rule");
  assert.doesNotMatch(logRule[1], /overflow-x:\s*hidden/);
});

test("webapp: bot/user transcript text is rendered via escaped interpolation, never v-html (hostile markup can't inject or defeat wrapping)", () => {
  const rowMatch = /<div v-if="turn\.user_text"[\s\S]*?<\/template>/.exec(transcriptVue);
  assert.ok(rowMatch, "expected to find the transcript row markup");
  const markup = rowMatch[0];
  assert.doesNotMatch(markup, /v-html/);
  assert.match(markup, /\{\{\s*turn\.user_text\s*\}\}/);
  assert.match(markup, /\{\{\s*turn\.bot_text/);
});

test("webapp: .tp-text keeps wrapping even for an oversized whitespace-free line (no unset min-width/word-break slipped back in)", () => {
  const bodyRule = /\.tp-body\s*\{([^}]*)\}/.exec(transcriptVue);
  const textRule = /\.tp-text\s*\{([^}]*)\}/.exec(transcriptVue);
  assert.ok(bodyRule && textRule, "expected .tp-body and .tp-text rules");
  assert.doesNotMatch(bodyRule[1], /min-width:\s*auto/);
  assert.doesNotMatch(textRule[1], /white-space:\s*nowrap/);
});
