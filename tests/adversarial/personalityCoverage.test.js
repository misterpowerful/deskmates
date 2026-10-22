import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../helpers/tmp.js";
import {
  expectedCategories,
  personalityCoverage,
  coverageWarning,
  runCoverageCheck,
  readDisplayName,
  deriveDisplayNameFromSlug,
  getPersonalityDisplayName,
  setPersonalityDisplayName,
  MAX_DISPLAY_NAME_LENGTH,
} from "../../src/personalityCoverage.js";

test("corrupt or non-object manifest falls back to manifest-free categories", () => {
  for (const body of ["{not json", "[1,2]", "null"]) {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "phrase-manifest.json"), body);
    assert.equal(expectedCategories(root).length, 5);
  }
  assert.equal(expectedCategories(makeTmpDir()).length, 5);
});

test("personality with no canned-responses dir or that does not exist reports zero", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "personalities", "reggie"), { recursive: true });
  for (const name of ["reggie", "ghost", "../escape"]) {
    const c = personalityCoverage(name, root);
    assert.equal(c.categoriesCovered, 0);
    assert.equal(c.missing.length, c.categoriesExpected);
  }
});

test("coverageWarning never throws for a nonexistent, escaping, or hostile name and always reports a gap", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "personalities", "reggie"), { recursive: true });
  for (const name of ["reggie", "ghost", "../escape", "", "a".repeat(10_000)]) {
    let msg;
    assert.doesNotThrow(() => {
      msg = coverageWarning(name, root);
    });
    assert.equal(typeof msg, "string");
    assert.match(msg, /missing:/);
  }
});

test("a file where a category dir is expected does not count", () => {
  const root = makeTmpDir();
  const d = path.join(root, "personalities", "p", "canned-responses", "shared");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "filler"), "x");
  assert.equal(personalityCoverage("p", root).categories.filler, 0);
});

test("unknown requested personality fails the check", () => {
  const r = runCoverageCheck({ names: ["nope"], all: ["a"], active: "a", root: makeTmpDir() });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /unknown personality/);
});

test("readDisplayName fails safe (returns null, never throws) on missing/malformed/hostile voice-config.json", () => {
  const root = makeTmpDir();
  const cases = {
    missingDir: null, // no personalities/<name> dir at all
    noFile: null, // dir exists, no voice-config.json inside
    notJson: "{not json",
    jsonArray: "[1, 2, 3]",
    jsonString: '"just a string"',
    noKey: JSON.stringify({ voice_id: "x" }),
    blank: JSON.stringify({ display_name: "   " }),
    emptyString: JSON.stringify({ display_name: "" }),
    wrongType: JSON.stringify({ display_name: 12345 }),
    nullValue: JSON.stringify({ display_name: null }),
    nested: JSON.stringify({ display_name: { name: "Gatsby" } }),
  };
  for (const [name, body] of Object.entries(cases)) {
    if (name === "missingDir") continue;
    fs.mkdirSync(path.join(root, "personalities", name), { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(root, "personalities", name, "voice-config.json"), body);
  }
  for (const name of Object.keys(cases)) {
    assert.equal(readDisplayName(name, root), null, `${name} should read as null`);
    // getPersonalityDisplayName must still hand back a usable non-empty
    // string (the slug-derived fallback) rather than propagating the null.
    const fallback = getPersonalityDisplayName(name, root);
    assert.equal(typeof fallback, "string");
    assert.ok(fallback.length > 0);
  }
});

test("readDisplayName trims surrounding whitespace and does not choke on a huge or hostile value", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "personalities", "padded"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "personalities", "padded", "voice-config.json"),
    JSON.stringify({ display_name: "  Gatsby  " }),
  );
  assert.equal(readDisplayName("padded", root), "Gatsby");

  const huge = "x".repeat(50_000);
  fs.mkdirSync(path.join(root, "personalities", "huge"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "personalities", "huge", "voice-config.json"),
    JSON.stringify({ display_name: huge }),
  );
  assert.equal(readDisplayName("huge", root), huge);

  const scripty = '<script>alert(1)</script>';
  fs.mkdirSync(path.join(root, "personalities", "scripty"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "personalities", "scripty", "voice-config.json"),
    JSON.stringify({ display_name: scripty }),
  );
  // Returned verbatim (as data, not markup) — sanitization for display is a
  // rendering-layer concern, not this reader's.
  assert.equal(readDisplayName("scripty", root), scripty);
});

test("deriveDisplayNameFromSlug fails safe on empty/malformed/hostile input", () => {
  assert.equal(deriveDisplayNameFromSlug(""), "BOT");
  assert.equal(deriveDisplayNameFromSlug(null), "BOT");
  assert.equal(deriveDisplayNameFromSlug(undefined), "BOT");
  assert.equal(deriveDisplayNameFromSlug(42), "BOT");
  assert.equal(deriveDisplayNameFromSlug({}), "BOT");
  assert.equal(deriveDisplayNameFromSlug("-"), "BOT");
  assert.equal(deriveDisplayNameFromSlug("-leading-dash"), "BOT");
});

test("getPersonalityDisplayName never throws for a path-traversal or nonexistent name", () => {
  const root = makeTmpDir();
  for (const name of ["../escape", "../../etc/passwd", "ghost", ""]) {
    assert.doesNotThrow(() => getPersonalityDisplayName(name, root));
  }
});

test("personalityCoverage().displayName is null (not throwing) for a nonexistent or escaping name", () => {
  const root = makeTmpDir();
  for (const name of ["ghost", "../escape"]) {
    assert.equal(personalityCoverage(name, root).displayName, null);
  }
});

test("setPersonalityDisplayName rejects blank, whitespace-only, non-string, and oversized names", () => {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, "personalities", "sam"), { recursive: true });
  fs.writeFileSync(path.join(root, "personalities", "sam", "voice-config.json"), JSON.stringify({}));
  for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
    assert.throws(() => setPersonalityDisplayName("sam", bad, root));
  }
  assert.throws(() => setPersonalityDisplayName("sam", "a".repeat(MAX_DISPLAY_NAME_LENGTH + 1), root), /too long/);
  // right at the limit is fine
  const atLimit = "a".repeat(MAX_DISPLAY_NAME_LENGTH);
  assert.equal(setPersonalityDisplayName("sam", atLimit, root), atLimit);
});

test("setPersonalityDisplayName throws rather than creating a voice-config.json for an unknown personality", () => {
  const root = makeTmpDir();
  assert.throws(() => setPersonalityDisplayName("ghost", "Ghost", root));
  assert.equal(fs.existsSync(path.join(root, "personalities", "ghost")), false);
});

test("setPersonalityDisplayName does not corrupt voice-config.json when writing a hostile-but-valid name", () => {
  const root = makeTmpDir();
  const dir = path.join(root, "personalities", "sam");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "voice-config.json"), JSON.stringify({ voice_id: "abc" }));
  const hostile = '<script>alert(1)</script>"; DROP TABLE x; --';
  const written = setPersonalityDisplayName("sam", hostile, root);
  assert.equal(written, hostile);
  assert.equal(readDisplayName("sam", root), hostile);
  // still valid JSON with the other key intact — a naive string-concat write
  // would have broken this
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "voice-config.json"), "utf8"));
  assert.equal(onDisk.voice_id, "abc");
});

test("setPersonalityDisplayName leaves no leftover tmp file behind on success", () => {
  const root = makeTmpDir();
  const dir = path.join(root, "personalities", "sam");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "voice-config.json"), JSON.stringify({}));
  setPersonalityDisplayName("sam", "Sam", root);
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, ["voice-config.json"]);
});
