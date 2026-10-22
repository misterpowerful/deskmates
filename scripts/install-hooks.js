import { execFileSync } from "node:child_process";

// Points this checkout's git at the committed hooks in .githooks/ (pre-push and
// pre-merge-commit run the test-gate check). Idempotent.
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: process.cwd() });
console.log("core.hooksPath = .githooks");
