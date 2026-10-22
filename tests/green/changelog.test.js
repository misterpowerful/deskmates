import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseChangelog, readChangelog } from "../../src/changelog.js";
import { makeTmpDir } from "../helpers/tmp.js";

test("parseChangelog reads dated headings and bullet items", () => {
  const md = [
    "# Changelog",
    "",
    "## 2026-09-22 — Second entry",
    "- did a thing",
    "- did another thing",
    "",
    "## 2026-09-20 — First entry",
    "- earlier thing",
  ].join("\n");
  const entries = parseChangelog(md);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { date: "2026-09-22", title: "Second entry", items: ["did a thing", "did another thing"] });
  assert.deepEqual(entries[1], { date: "2026-09-20", title: "First entry", items: ["earlier thing"] });
});

test("parseChangelog sorts newest first regardless of file order", () => {
  const md = ["## 2026-01-01 — oldest", "- a", "## 2026-06-01 — middle", "- b", "## 2026-09-01 — newest", "- c"].join("\n");
  const entries = parseChangelog(md);
  assert.deepEqual(entries.map((e) => e.date), ["2026-09-01", "2026-06-01", "2026-01-01"]);
});

test("parseChangelog handles a heading with no dash-separated title", () => {
  const entries = parseChangelog("## 2026-09-22\n- x");
  assert.equal(entries[0].title, "2026-09-22");
});

test("parseChangelog handles an undated heading", () => {
  const entries = parseChangelog("## Unreleased\n- pending item");
  assert.deepEqual(entries[0], { date: null, title: "Unreleased", items: ["pending item"] });
});

test("parseChangelog keeps multiple undated entries in their original file order", () => {
  const md = "## First undated\n- a\n## Second undated\n- b";
  const entries = parseChangelog(md);
  assert.deepEqual(entries.map((e) => e.title), ["First undated", "Second undated"]);
});

test("readChangelog reads a real file from disk", () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## 2026-09-22 — Only entry\n- one\n- two\n");
  const { entries, error } = readChangelog({ cwd: dir });
  assert.equal(error, null);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].items, ["one", "two"]);
});

test("the repo's own CHANGELOG.md parses and renders newest first", () => {
  const { entries, error } = readChangelog({ cwd: process.cwd() });
  assert.equal(error, null);
  assert.ok(entries.length > 0);
  const dated = entries.filter((e) => e.date);
  for (let i = 1; i < dated.length; i++) {
    assert.ok(dated[i - 1].date >= dated[i].date, "entries must be newest first");
  }
});
