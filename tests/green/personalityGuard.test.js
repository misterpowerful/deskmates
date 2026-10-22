import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  checkPersonalityChange,
  extractQuotes,
  quoteIsGenuine,
  speedProblems,
  loadRecentTranscripts,
} from "../../scripts/lib/personalityGuard.js";

const voice = (friendly) => JSON.stringify({ voice_id: "v", speed: { friendly } });

test("a build that touches no personality files passes untouched", () => {
  const r = checkPersonalityChange({ changedFiles: ["src/x.js"], taskText: "", transcripts: [], readBefore: () => "", readAfter: () => "" });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test("a personality change backed by the owner's real words, in a small speed step, passes", () => {
  const r = checkPersonalityChange({
    changedFiles: ["personalities/gatsby-sardonic/voice-config.json"],
    taskText: 'The owner said: "I think you might be talking a little too fast". Slow down a touch.',
    transcripts: ["I think you might be talking a little too fast"],
    readBefore: () => voice(1.0),
    readAfter: () => voice(0.95),
  });
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("quotes are found in straight or curly quotes and matched ignoring case and punctuation", () => {
  assert.deepEqual(extractQuotes('He said "Speak a bit slower, please" and “don’t call me darling, ok”'), [
    "Speak a bit slower, please",
    "don’t call me darling, ok",
  ]);
  assert.equal(quoteIsGenuine("Speak a bit SLOWER please!", ["uh, speak a bit slower, please"]), true);
});

test("recent transcripts are read from the turn log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pguard-"));
  const dbPath = path.join(dir, "turns.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE turns (ts TEXT, transcript TEXT)");
  db.prepare("INSERT INTO turns VALUES (?, ?)").run(new Date().toISOString(), "slow down please Gatsby");
  db.prepare("INSERT INTO turns VALUES (?, ?)").run("2020-01-01T00:00:00Z", "ancient history");
  db.close();
  assert.deepEqual(loadRecentTranscripts(dbPath), ["slow down please Gatsby"]);
  assert.deepEqual(speedProblems(voice(1.0), voice(1.1)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
