import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function makeTmpDir(prefix = "deskmates-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A throwaway git repo with one commit; returns its path.
export function makeTmpRepo() {
  const dir = makeTmpDir("deskmates-repo-");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git, env };
}
