import { execFileSync } from "node:child_process";
import { runGate, stampPass, changedFilesSince } from "./lib/gate.js";

// Manual gate run: `npm run gate [-- --base <ref>]`. Runs the full test gate
// over this checkout and, if clean and everything is committed, stamps HEAD so
// the pre-push / pre-merge-commit hooks let it through.

const ROOT = process.cwd();

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function defaultBase() {
  try {
    git(["rev-parse", "--verify", "origin/main"]);
    return "origin/main";
  } catch {
    return "main";
  }
}

const baseIdx = process.argv.indexOf("--base");
const baseRef = baseIdx > 0 ? process.argv[baseIdx + 1] : defaultBase();

const result = await runGate(ROOT, { baseRef });
for (const s of result.stages) console.log(`${s.passed ? "PASS" : "FAIL"}  ${s.stage}`);
for (const f of result.failures) {
  console.log(`\n[${f.stage}]${f.id ? ` ${f.id}` : ""}\n${String(f.message ?? "").slice(0, 1500)}`);
}

if (!result.passed) {
  console.log("\nGate FAILED — not stamped.");
  process.exit(1);
}

const dirty = git(["status", "--porcelain", "--", ".", ":!logs", ":!tasks", ":!data"]);
if (dirty) {
  console.log("\nGate passed, but there are uncommitted code changes — commit them and re-run to stamp.");
  process.exit(1);
}
const fp = stampPass(ROOT, "HEAD");
console.log(`\nGate passed against ${baseRef}; stamped HEAD (${fp.slice(0, 12)}). ${changedFilesSince(ROOT, baseRef).length} file(s) differ from ${baseRef}.`);
