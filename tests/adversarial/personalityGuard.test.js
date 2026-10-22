import test from "node:test";
import assert from "node:assert/strict";
import { checkPersonalityChange, speedProblems, quoteIsGenuine, extractQuotes, loadRecentTranscripts } from "../../scripts/lib/personalityGuard.js";

const voice = (speed) => JSON.stringify({ speed });

test("the 1.15 -> 0.85 slowdown would have been rejected: too big a step and below the floor", () => {
  const r = checkPersonalityChange({
    changedFiles: ["personalities/gatsby-sardonic/voice-config.json"],
    taskText: 'The owner said "I think you might be talking a little too fast"',
    transcripts: ["I think you might be talking a little too fast"],
    readBefore: () => voice({ friendly: 1.15, sentry_intruder: 1.0 }),
    readAfter: () => voice({ friendly: 0.85, sentry_intruder: 0.85 }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /more than 0.1/.test(p)));
  assert.ok(r.problems.some((p) => /outside/.test(p)));
});

test("a personality rewrite with an invented or paraphrased reason is rejected", () => {
  const base = {
    changedFiles: ["personalities/gatsby-sardonic/personality-breakdown.md"],
    transcripts: ["what's for dinner?"],
    readBefore: () => "",
    readAfter: () => "",
  };
  assert.equal(checkPersonalityChange({ ...base, taskText: "The owner reports Gatsby is too gloomy." }).ok, false);
  assert.equal(checkPersonalityChange({ ...base, taskText: 'The owner said "please be much more gloomy"' }).ok, false);
  assert.equal(checkPersonalityChange({ ...base, taskText: 'The owner said "ok"' }).ok, false, "too short to count");
});

test("garbage speed values and broken JSON are problems, not crashes", () => {
  assert.deepEqual(speedProblems("{}", "not json"), ["voice-config.json is not valid JSON"]);
  assert.ok(speedProblems("not json", voice({ friendly: "fast" }))[0].includes("not a number"));
  assert.ok(speedProblems("{}", voice({ friendly: 3 }))[0].includes("outside"));
  assert.deepEqual(speedProblems("{}", JSON.stringify({ voice_id: "v" })), []);
});

test("quote checks ignore tiny fragments, and a missing turn log means no evidence", () => {
  assert.equal(quoteIsGenuine("ok", ["ok"]), false);
  assert.deepEqual(extractQuotes(null), []);
  assert.deepEqual(loadRecentTranscripts("/nonexistent/turns.db"), []);
});
