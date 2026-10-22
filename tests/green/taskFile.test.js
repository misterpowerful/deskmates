import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseTaskFile, sortOldestFirst, writeTaskFile, appendNote, listTaskFiles } from "../../src/taskFile.js";
import { makeTmpDir } from "../helpers/tmp.js";

test("parseTaskFile reads frontmatter and body", () => {
  const { frontmatter, body } = parseTaskFile("---\nsource: gatsby\ntitle: Hi\n---\n\nDo the thing.\n");
  assert.deepEqual(frontmatter, { source: "gatsby", title: "Hi" });
  assert.equal(body, "Do the thing.");
});

test("parseTaskFile without frontmatter returns the whole text as body", () => {
  assert.deepEqual(parseTaskFile("just text\n"), { frontmatter: {}, body: "just text" });
});

test("parseTaskFile handles CRLF", () => {
  const { frontmatter, body } = parseTaskFile("---\r\nsource: a\r\ntitle: b\r\n---\r\nbody\r\n");
  assert.equal(frontmatter.title, "b");
  assert.equal(body, "body");
});

test("sortOldestFirst orders by created", () => {
  const tasks = [
    { frontmatter: { created: "2026-02-01T00:00:00Z" }, mtimeMs: 0, n: "b" },
    { frontmatter: { created: "2026-01-01T00:00:00Z" }, mtimeMs: 9, n: "a" },
  ];
  assert.deepEqual(sortOldestFirst(tasks).map((t) => t.n), ["a", "b"]);
});

test("sortOldestFirst falls back to mtime when created is missing", () => {
  const tasks = [
    { frontmatter: {}, mtimeMs: Date.parse("2026-03-01"), n: "late" },
    { frontmatter: { created: "2026-01-01T00:00:00Z" }, mtimeMs: 0, n: "early" },
  ];
  assert.deepEqual(sortOldestFirst(tasks).map((t) => t.n), ["early", "late"]);
});

test("writeTaskFile writes frontmatter, slugs the title, and suffixes collisions", () => {
  const dir = makeTmpDir();
  const a = writeTaskFile(dir, { source: "s", title: "Add A Thing!", description: " Do it " });
  const b = writeTaskFile(dir, { source: "s", title: "Add A Thing!", description: "again" });
  assert.match(a.filename, /^add-a-thing-\d+\.md$/);
  assert.notEqual(a.filename, b.filename);
  const raw = fs.readFileSync(a.filePath, "utf8");
  const parsed = parseTaskFile(raw);
  assert.equal(parsed.frontmatter.title, "Add A Thing!");
  assert.equal(parsed.frontmatter.source, "s");
  assert.equal(parsed.body, "Do it");
  assert.equal(listTaskFiles(dir).length, 2);
});

test("appendNote appends a titled note", () => {
  assert.equal(appendNote("body\n", "Done", "ok"), "body\n\n---\nDone: ok\n");
});
