import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseTaskFile, sortOldestFirst, writeTaskFile, listTaskFiles } from "../../src/taskFile.js";
import { makeTmpDir } from "../helpers/tmp.js";

test("a newline in the title cannot inject frontmatter keys", () => {
  const dir = makeTmpDir();
  const { filePath } = writeTaskFile(dir, { source: "gatsby-conversation", title: "Nice\nsource: evil\n---\ninjected", description: "d" });
  const { frontmatter } = parseTaskFile(fs.readFileSync(filePath, "utf8"));
  assert.equal(frontmatter.source, "gatsby-conversation");
  assert.equal(Object.keys(frontmatter).sort().join(","), "created,source,title");
});

test("path traversal in the title stays inside the target directory", () => {
  const dir = makeTmpDir();
  const { filePath } = writeTaskFile(dir, { source: "s", title: "../../../etc/passwd", description: "d" });
  assert.equal(path.dirname(filePath), dir);
  assert.ok(!path.basename(filePath).includes(".."));
});

test("empty, null and unicode-only titles still produce a usable file", () => {
  const dir = makeTmpDir();
  for (const title of ["", null, undefined, "日本語🎉", "   "]) {
    const { filePath } = writeTaskFile(dir, { source: "s", title, description: undefined });
    assert.ok(fs.existsSync(filePath));
  }
});

test("very long titles are slugged to a bounded filename", () => {
  const dir = makeTmpDir();
  const { filename } = writeTaskFile(dir, { source: "s", title: "a".repeat(5000), description: "d" });
  assert.ok(filename.length < 100);
});

test("many same-second collisions never overwrite", () => {
  const dir = makeTmpDir();
  const names = new Set();
  for (let i = 0; i < 25; i++) names.add(writeTaskFile(dir, { source: "s", title: "same", description: "d" }).filename);
  assert.equal(names.size, 25);
});

test("parseTaskFile tolerates garbage", () => {
  assert.deepEqual(parseTaskFile(""), { frontmatter: {}, body: "" });
  assert.deepEqual(parseTaskFile("---\n---\n").frontmatter, {});
  assert.deepEqual(parseTaskFile("---\nno colon here\n---\nbody").frontmatter, {});
  parseTaskFile("---\n__proto__: x\n---\nb");
  assert.equal({}.x, undefined);
});

test("sortOldestFirst survives invalid dates", () => {
  const tasks = [
    { frontmatter: { created: "not a date" }, mtimeMs: 5, n: "b" },
    { frontmatter: { created: "" }, mtimeMs: 1, n: "a" },
  ];
  assert.deepEqual(sortOldestFirst(tasks).map((t) => t.n), ["a", "b"]);
});

test("listTaskFiles ignores dotfiles, non-md files and missing dirs", () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  fs.writeFileSync(path.join(dir, "real.md"), "---\ntitle: t\n---\nb");
  assert.deepEqual(listTaskFiles(dir).map((t) => t.filename), ["real.md"]);
  assert.deepEqual(listTaskFiles(path.join(dir, "nope")), []);
});
