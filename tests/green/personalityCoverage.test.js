import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../helpers/tmp.js";
import {
  expectedCategories,
  personalityCoverage,
  coverageSummary,
  coverageWarning,
  runCoverageCheck,
  readDisplayName,
  deriveDisplayNameFromSlug,
  getPersonalityDisplayName,
  setPersonalityDisplayName,
} from "../../src/personalityCoverage.js";

const root = makeTmpDir();
fs.mkdirSync(path.join(root, "data"));
fs.writeFileSync(path.join(root, "data", "phrase-manifest.json"), JSON.stringify({ Fact: [], Joke: [] }));
function put(p, name, file = "a.pcm") {
  const d = path.join(root, "personalities", p, ...name.split("/"));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), "x");
}
for (const c of ["Fact", "Joke"]) put("full", `canned-responses/shared/${c}`);
for (const c of ["filler", "greeting", "question_filler", "custom-memory_saved", "pipeline_error"]) {
  put("full", `canned-responses/friendly/${c}`);
}
fs.writeFileSync(
  path.join(root, "personalities", "full", "voice-config.json"),
  JSON.stringify({ display_name: "Full" }),
);
put("partial", "canned-responses/shared/Fact");
put("partial", "canned-responses/shared/Joke", ".gitkeep");
fs.mkdirSync(path.join(root, "personalities", "empty"));
// Fully covered on canned-response categories, same as "full", but with no
// display_name — isolates the display_name-only gate from a categories gap.
for (const c of ["Fact", "Joke"]) put("unnamed", `canned-responses/shared/${c}`);
for (const c of ["filler", "greeting", "question_filler", "custom-memory_saved", "pipeline_error"]) {
  put("unnamed", `canned-responses/friendly/${c}`);
}

test("expected categories merge manifest keys and manifest-free ones", () => {
  assert.deepEqual(expectedCategories(root), [
    "Fact", "Joke", "custom-memory_saved", "filler", "greeting", "pipeline_error", "question_filler",
  ]);
});

test("fully populated personality has no gaps", () => {
  const c = personalityCoverage("full", root);
  assert.equal(c.categoriesCovered, 7);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.files, { "personality-breakdown.md": false, "voice-config.json": true });
  assert.equal(c.displayName, "Full");
});

test("readDisplayName reads a trimmed display_name, and null when unset", () => {
  assert.equal(readDisplayName("full", root), "Full");
  assert.equal(readDisplayName("empty", root), null);
});

test("deriveDisplayNameFromSlug matches the webapp's slug-derivation fallback", () => {
  assert.equal(deriveDisplayNameFromSlug("gatsby-sardonic"), "Gatsby");
  assert.equal(deriveDisplayNameFromSlug("chet"), "Chet");
  assert.equal(deriveDisplayNameFromSlug("reggie"), "Reggie");
});

test("getPersonalityDisplayName prefers the explicit name, falls back to the slug derivation", () => {
  assert.equal(getPersonalityDisplayName("full", root), "Full");
  assert.equal(getPersonalityDisplayName("empty", root), "Empty");
});

test("setPersonalityDisplayName rewrites display_name and preserves other keys", () => {
  const r = makeTmpDir();
  const dir = path.join(r, "personalities", "sam");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "voice-config.json"), JSON.stringify({ voice_id: "abc", model: "x" }));
  const written = setPersonalityDisplayName("sam", "  New Name  ", r);
  assert.equal(written, "New Name");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "voice-config.json"), "utf8"));
  assert.deepEqual(onDisk, { voice_id: "abc", model: "x", display_name: "New Name" });
  assert.equal(readDisplayName("sam", r), "New Name");
});

test("coverageWarning is null for a fully covered personality, and names the gaps otherwise", () => {
  assert.equal(coverageWarning("full", root), null);
  const msg = coverageWarning("partial", root);
  assert.match(msg, /partial/);
  assert.match(msg, /1\/7 categories covered/);
  assert.match(msg, /missing: .*Joke/);
});

test("dotfiles do not count and summary is additive-shaped", () => {
  assert.deepEqual(coverageSummary("partial", root), { categoriesCovered: 1, categoriesExpected: 7 });
  assert.equal(personalityCoverage("partial", root).categories.Joke, 0);
});

test("runCoverageCheck reports per personality and fails on active gap", () => {
  const all = ["empty", "full", "partial"];
  const ok = runCoverageCheck({ names: ["full"], all, active: "full", root });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /full \(active\): 7\/7 categories covered/);
  assert.match(ok.output, /display_name: "Full"/);
  const bad = runCoverageCheck({ names: [], all, active: "empty", root });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.output, /empty \(active\): 0\/7 categories covered/);
  assert.match(bad.output, /missing: Fact, Joke/);
  assert.match(bad.output, /voice-config.json: MISSING/);
  assert.match(bad.output, /display_name: MISSING/);
  const inactiveGap = runCoverageCheck({ names: ["partial"], all, active: "full", root });
  assert.equal(inactiveGap.exitCode, 0);
  // partial has no display_name and isn't active, so it doesn't gate exitCode...
  assert.match(inactiveGap.output, /display_name: MISSING/);
  // ...but an active personality missing only display_name (no canned-response
  // gaps otherwise) still fails, same as a canned-response gap would.
  const displayNameOnlyGap = runCoverageCheck({
    names: ["unnamed"],
    all: [...all, "unnamed"],
    active: "unnamed",
    root,
  });
  assert.equal(displayNameOnlyGap.exitCode, 1);
  assert.match(displayNameOnlyGap.output, /unnamed \(active\): 7\/7 categories covered/);
  assert.match(displayNameOnlyGap.output, /display_name: MISSING/);
});
