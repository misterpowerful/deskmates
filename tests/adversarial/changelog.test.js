import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseChangelog, readChangelog } from "../../src/changelog.js";
import { makeTmpDir } from "../helpers/tmp.js";

test("parseChangelog tolerates non-strings and empty input", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   \n  "]) {
    assert.deepEqual(parseChangelog(bad), []);
  }
});

test("parseChangelog ignores garbage with no headings", () => {
  assert.deepEqual(parseChangelog("just some\nrandom text\n- a bullet with no heading above it"), []);
});

test("parseChangelog treats an empty heading as no entry", () => {
  assert.deepEqual(parseChangelog("## \n- orphaned item"), []);
});

test("parseChangelog does not execute or unwrap markup in headings/items", () => {
  const md = "## 2026-09-22 — <script>alert(1)</script>\n- <img src=x onerror=alert(1)>\n- normal text";
  const entries = parseChangelog(md);
  assert.equal(entries.length, 1);
  // Preserved as inert plain text for the caller (Vue renders it via text
  // interpolation, never v-html) rather than stripped or executed.
  assert.match(entries[0].title, /<script>/);
  assert.match(entries[0].items[0], /<img/);
});

test("parseChangelog caps a pathologically large number of entries and items", () => {
  const heading = Array.from({ length: 1000 }, (_, i) => `## 2026-01-01 — h${i}\n- x`).join("\n");
  const entries = parseChangelog(heading);
  assert.ok(entries.length <= 500);

  const manyItems = ["## 2026-01-01 — big", ...Array.from({ length: 1000 }, (_, i) => `- item ${i}`)].join("\n");
  const [entry] = parseChangelog(manyItems);
  assert.ok(entry.items.length <= 200);
});

test("parseChangelog treats malformed dates as an undated title, not a crash", () => {
  const entries = parseChangelog("## 9999-99-99 nonsense date — but has a title\n- x");
  assert.equal(entries.length, 1);
  // Not a valid YYYY-MM-DD calendar date, but the regex is a shape check,
  // not a calendar validator — this is documented behavior, not a crash.
  assert.equal(typeof entries[0].date, "string");
});

test("readChangelog on a missing file fails safely", () => {
  const r = readChangelog({ cwd: makeTmpDir() });
  assert.deepEqual(r, { entries: [], error: "changelog unavailable" });
});

test("readChangelog on a nonexistent cwd fails safely", () => {
  assert.deepEqual(readChangelog({ cwd: "/nonexistent/xyz" }), { entries: [], error: "changelog unavailable" });
});

test("readChangelog refuses a directory named like the file", () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, "CHANGELOG.md"));
  assert.deepEqual(readChangelog({ cwd: dir }), { entries: [], error: "changelog unavailable" });
});

test("readChangelog caps an oversized file instead of reading it fully into memory", () => {
  const dir = makeTmpDir();
  const bigHeader = "## 2026-09-22 — huge\n";
  const filler = "- " + "x".repeat(1024) + "\n";
  const content = bigHeader + filler.repeat(1024); // well over 512KB
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), content);
  const { entries, error } = readChangelog({ cwd: dir });
  assert.equal(error, null);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].items.length <= 200);
});

test("readChangelog with an out-of-order, partly-malformed file still sorts safely", () => {
  const dir = makeTmpDir();
  const content = [
    "not a heading at all",
    "## 2026-03-01 — middle",
    "- b",
    "## nonsense heading with no date",
    "- undated",
    "## 2026-09-01 — newest",
    "- c",
    "## 2026-01-01 — oldest",
    "- a",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), content);
  const { entries, error } = readChangelog({ cwd: dir });
  assert.equal(error, null);
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2026-09-01", "2026-03-01", "2026-01-01", null],
  );
});
