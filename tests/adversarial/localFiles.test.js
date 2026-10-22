import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// localFiles.js resolves its sandbox root from process.cwd() once, at import
// time — so both fixture trees have to exist and the process has to chdir
// into ROOT *before* the module is first imported.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "localfiles-adv-root-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "localfiles-adv-outside-"));

// A real "secret" sitting directly inside the sandbox root, plus a symlink
// planted inside it that points straight at that secret — the exact attack
// localFiles.js's own comments describe: the lexical path ("sub/notes.txt")
// looks completely ordinary, only the resolved real path reveals ".env".
fs.writeFileSync(path.join(ROOT, ".env"), "SECRET_KEY=abc");
fs.mkdirSync(path.join(ROOT, "sub"));
fs.writeFileSync(path.join(ROOT, "sub", "real.txt"), "hi");
fs.symlinkSync(path.join("..", ".env"), path.join(ROOT, "sub", "notes.txt"));

// A symlink pointing entirely outside the repo root, at both an ordinary
// file and a stand-in .env, plus one pointing at a target that never gets
// created.
fs.writeFileSync(path.join(OUTSIDE, "outside-secret.txt"), "OUTSIDE SECRET");
fs.writeFileSync(path.join(OUTSIDE, ".env"), "OUTSIDE_ENV=1");
fs.symlinkSync(path.join(OUTSIDE, "outside-secret.txt"), path.join(ROOT, "sub", "escape-link"));
fs.symlinkSync(path.join(OUTSIDE, ".env"), path.join(ROOT, "sub", "env-leak-link"));
fs.symlinkSync(path.join(ROOT, "sub", "does-not-exist.txt"), path.join(ROOT, "sub", "dangling-link"));

// A file over the read cap.
const MAX_READ_BYTES = 200_000;
fs.writeFileSync(path.join(ROOT, "sub", "big.bin"), "x".repeat(MAX_READ_BYTES + 1));

const prevCwd = process.cwd();
process.chdir(ROOT);
const { listLocalDirectory, readLocalFile } = await import("../../src/tools/localFiles.js");

test.after(() => {
  process.chdir(prevCwd);
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

test("../-style traversal outside the repo root is rejected for both list and read", async () => {
  for (const p of ["../etc/passwd", "sub/../../escape", "..", "sub/../.."]) {
    await assert.rejects(readLocalFile({ path: p }), /resolves outside the repository/);
    await assert.rejects(listLocalDirectory({ path: p }), /resolves outside the repository/);
  }
});

test("a symlink whose lexical path looks fine but resolves outside the repo is rejected", async () => {
  await assert.rejects(readLocalFile({ path: "sub/escape-link" }), /resolves outside the repository/);
});

test("a symlink pointing at a stand-in .env outside the repo is rejected", async () => {
  await assert.rejects(readLocalFile({ path: "sub/env-leak-link" }), /resolves outside the repository/);
});

test("a symlink to a real .env inside the repo is rejected by the hidden-segment check", async () => {
  await assert.rejects(readLocalFile({ path: "sub/notes.txt" }), /hidden\/blocked path segment/);
});

test("a bare .env/.git/node_modules/logs segment anywhere in the path is rejected for both list and read", async () => {
  const paths = [
    ".env",
    ".git",
    "node_modules",
    "node_modules/pkg.js",
    "sub/.env",
    "a/b/.git/config",
    "logs",
    "logs/turns.jsonl",
    "logs/turns.db",
    "a/logs/self-build-123.json",
  ];
  for (const p of paths) {
    await assert.rejects(readLocalFile({ path: p }), /hidden\/blocked path segment/, `read allowed "${p}"`);
    await assert.rejects(listLocalDirectory({ path: p }), /hidden\/blocked path segment/, `list allowed "${p}"`);
  }
});

test("a symlink to a target that doesn't exist yet fails safely instead of crashing", async () => {
  await assert.rejects(readLocalFile({ path: "sub/dangling-link" }), (err) => {
    assert.equal(err.code, "ENOENT");
    return true;
  });
});

test("a file over MAX_READ_BYTES is refused with a clear error instead of a partial read", async () => {
  await assert.rejects(readLocalFile({ path: "sub/big.bin" }), /over the 200000-byte read limit/);
});

test("readLocalFile on a directory and listLocalDirectory on a file fail with a clear error", async () => {
  await assert.rejects(readLocalFile({ path: "sub" }), /is not a file/);
  await assert.rejects(listLocalDirectory({ path: "sub/real.txt" }), /is a file, not a directory/);
});
