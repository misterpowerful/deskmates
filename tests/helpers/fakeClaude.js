import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./tmp.js";

// A stand-in for the real `claude` binary so tests of src/delegatedTasks.js
// never spawn the actual CLI (no network, no API/subscription spend — see
// TESTING-GATE.md's offline rule). Echoes whatever JSON the caller put in
// FAKE_CLAUDE_RESPONSE (an already-serialized --output-format json envelope)
// to stdout and exits 0; if FAKE_CLAUDE_SLEEP_MS is set, sleeps first (used
// to test the worker timeout/kill path). Reads from env rather than argv so
// the exact prompt/flags spawnClaudeWorker passed are irrelevant to the fake.
export function makeFakeClaudeBin() {
  const dir = makeTmpDir("deskmates-fake-claude-");
  const binPath = path.join(dir, "claude");
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS) || 0;
setTimeout(() => {
  // Optional: record exactly how the worker was invoked (argv, cwd, and what
  // sits in that cwd) so a test can assert on tool lists and file placement.
  if (process.env.FAKE_CLAUDE_RECORD) {
    const nodeFs = require("node:fs");
    nodeFs.writeFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), files: nodeFs.readdirSync(process.cwd()) }),
    );
  }
  process.stdout.write(process.env.FAKE_CLAUDE_RESPONSE ?? "");
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT_CODE) || 0);
}, sleepMs);
`,
  );
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

export function fakeSuccessEnvelope({ summary = "Done.", result = "Full details.", needsConfirmation = false } = {}) {
  return JSON.stringify({
    is_error: false,
    result: JSON.stringify({ summary, result, needs_confirmation: needsConfirmation }),
  });
}

// A task's worker is deliberately fire-and-forget (see createDelegatedTask)
// — a test that cleans up delegated-tasks/ right after the pipeline call
// returns can race a still-running worker and end up deleting the directory
// out from under it, which then gets silently recreated moments later with
// a stray leftover file once the worker finally writes its result. Callers
// that trigger delegation and then want a clean directory must wait for
// every task to leave "running" first.
export async function waitForAllDelegatedTasksSettled(listTasks, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stillRunning = listTasks({ includeHeard: true }).some((t) => t.status === "running");
    if (!stillRunning) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
