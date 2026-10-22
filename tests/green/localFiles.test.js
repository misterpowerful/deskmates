import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// localFiles.js resolves its sandbox root from process.cwd() once, at import
// time — so the fixture directory has to exist and the process has to chdir
// into it *before* the module is first imported.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "localfiles-green-"));

fs.writeFileSync(path.join(ROOT, "root-file.txt"), "root content");
fs.mkdirSync(path.join(ROOT, "sub"));
fs.writeFileSync(path.join(ROOT, "sub", "alpha.txt"), "alpha content");
fs.mkdirSync(path.join(ROOT, "sub", "zeta"));
fs.symlinkSync(path.join(ROOT, "sub", "alpha.txt"), path.join(ROOT, "sub", "beta-link"));
// Real hidden entries mixed in, to confirm the listing filter hides them
// even in an otherwise ordinary directory.
fs.writeFileSync(path.join(ROOT, "sub", ".env"), "SECRET=1");
fs.mkdirSync(path.join(ROOT, "sub", "node_modules"));
fs.mkdirSync(path.join(ROOT, "sub", "logs"));
fs.writeFileSync(path.join(ROOT, "sub", "logs", "turns.jsonl"), '{"role":"user"}');

const prevCwd = process.cwd();
process.chdir(ROOT);
const { listLocalDirectory, readLocalFile } = await import("../../src/tools/localFiles.js");

test.after(() => {
  process.chdir(prevCwd);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("listLocalDirectory returns entries sorted by name with correct type/path, hiding sensitive entries", async () => {
  const result = await listLocalDirectory({ path: "sub" });
  assert.equal(result.path, "sub");
  assert.deepEqual(result.entries, [
    { name: "alpha.txt", type: "file", path: path.join("sub", "alpha.txt") },
    { name: "beta-link", type: "symlink", path: path.join("sub", "beta-link") },
    { name: "zeta", type: "dir", path: path.join("sub", "zeta") },
  ]);
  assert.ok(
    !result.entries.some((e) => e.name === "logs"),
    "logs/ (which holds raw conversation transcripts) must not appear in a directory listing",
  );
});

test("readLocalFile returns exact content and relative path for a real file under the size cap", async () => {
  const result = await readLocalFile({ path: "sub/alpha.txt" });
  assert.deepEqual(result, { path: path.join("sub", "alpha.txt"), content: "alpha content" });
});

test("omitting path (or passing '.') on local_list_directory lists the root", async () => {
  const noPath = await listLocalDirectory({});
  const dotPath = await listLocalDirectory({ path: "." });
  for (const result of [noPath, dotPath]) {
    assert.equal(result.path, ".");
    assert.deepEqual(
      result.entries.map((e) => e.name),
      ["root-file.txt", "sub"],
    );
  }
});
