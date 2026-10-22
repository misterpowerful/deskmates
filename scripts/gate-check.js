import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { codeFingerprint, hasStamp } from "./lib/gate.js";

// Git hook entry point (see .githooks/). Refuses to let code that has not
// passed the test gate be merged or pushed. Changes that only touch tasks/,
// logs/ or data/ never need a pass.
//
// Usage (from hooks): node scripts/gate-check.js pre-push|pre-merge-commit

const ZERO = /^0+$/;
const cwd = process.cwd();

function git(args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tryFingerprint(treeish) {
  try {
    return codeFingerprint(cwd, treeish);
  } catch {
    return null;
  }
}

function refuse(what, fp) {
  process.stderr.write(
    `\nGATE: refusing ${what}: this code has not passed the test gate (code fingerprint ${fp.slice(0, 12)}).\n` +
      `Run \`npm run gate\` on a clean, committed checkout (it stamps the commit when green-path and adversarial tests are clean).\n\n`,
  );
  process.exit(1);
}

function preMergeCommit() {
  const fp = codeFingerprint(cwd, git(["write-tree"]));
  if (fp === tryFingerprint("HEAD") || hasStamp(cwd, fp)) return;
  refuse("this merge", fp);
}

function prePush() {
  const originMain = tryFingerprint("origin/main");
  const lines = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.split(" ");
    if (!localSha || ZERO.test(localSha) || remoteRef?.startsWith("refs/tags/")) continue;
    const fp = codeFingerprint(cwd, localSha);
    if (hasStamp(cwd, fp) || fp === originMain) continue;
    if (remoteSha && !ZERO.test(remoteSha) && fp === tryFingerprint(remoteSha)) continue;
    refuse(`push of ${remoteRef}`, fp);
  }
}

const hook = process.argv[2];
if (hook === "pre-push") prePush();
else if (hook === "pre-merge-commit") preMergeCommit();
else {
  process.stderr.write(`gate-check: unknown hook "${hook}"\n`);
  process.exit(2);
}
