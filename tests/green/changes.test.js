import test from "node:test";
import assert from "node:assert/strict";
import { parseGitLog, groupByDay, recentChanges, clampDays } from "../../src/changes.js";
import { makeTmpRepo } from "../helpers/tmp.js";

const rec = (h, d, a, s) => `${h}\x1f${d}\x1f${a}\x1f${s}\x1e\n`;
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);

test("parseGitLog reads fields and flags overnight commits", () => {
  const out = parseGitLog(rec(H1, "2026-09-22T02:15:00+00:00", "bot", "Nightly build") + rec(H2, "2026-09-21T14:05:00+00:00", "me", "Day fix"));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { hash: H1, short: "aaaaaaa", date: "2026-09-22", time: "02:15", night: true, author: "bot", subject: "Nightly build" });
  assert.equal(out[1].night, false);
});

test("groupByDay groups commits, newest day first", () => {
  const commits = parseGitLog(rec(H1, "2026-09-21T10:00:00Z", "a", "x") + rec(H2, "2026-09-22T01:00:00Z", "a", "y") + rec(H3, "2026-09-21T09:00:00Z", "a", "z"));
  const days = groupByDay(commits);
  assert.deepEqual(days.map((d) => d.date), ["2026-09-22", "2026-09-21"]);
  assert.deepEqual(days[1].commits.map((c) => c.subject), ["x", "z"]);
});

test("clampDays defaults and caps", () => {
  assert.equal(clampDays(14), 14);
  assert.equal(clampDays(9999), 90);
  assert.equal(clampDays(undefined), 7);
});

test("recentChanges reads a real repo's history", () => {
  const repo = makeTmpRepo();
  const { days, error } = recentChanges({ cwd: repo.dir, days: 3 });
  assert.equal(error, null);
  assert.equal(days.length, 1);
  assert.equal(days[0].commits[0].subject, "init");
});
