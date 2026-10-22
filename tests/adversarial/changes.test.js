import test from "node:test";
import assert from "node:assert/strict";
import { parseGitLog, recentChanges, clampDays, groupByDay } from "../../src/changes.js";
import { makeTmpDir } from "../helpers/tmp.js";

test("parseGitLog tolerates non-strings and garbage records", () => {
  for (const bad of [null, undefined, 42, {}, "", "garbage", "\x1e\x1e", "zz\x1f2026-01-01T00:00:00Z\x1fa\x1fs\x1e"]) {
    assert.deepEqual(parseGitLog(bad), []);
  }
});

test("parseGitLog rejects bad dates but keeps subjects containing separators", () => {
  assert.deepEqual(parseGitLog(`${"a".repeat(40)}\x1fyesterday\x1fa\x1fs\x1e`), []);
  const [c] = parseGitLog(`${"a".repeat(40)}\x1f2026-01-01T06:00:00Z\x1fa\x1fone\x1ftwo\x1e`);
  assert.equal(c.subject, "one\x1ftwo");
  assert.equal(c.night, false);
});

test("clampDays rejects hostile values", () => {
  for (const bad of [-5, 0, NaN, Infinity, "abc", null, {}, "1; rm -rf /"]) {
    assert.equal(clampDays(bad), 7);
  }
  assert.equal(clampDays(1e9), 90);
});

test("recentChanges outside a git repo fails safely", () => {
  const r = recentChanges({ cwd: makeTmpDir(), days: 7 });
  assert.deepEqual(r, { days: [], error: "git history unavailable" });
});

test("recentChanges with nonexistent cwd fails safely", () => {
  assert.equal(recentChanges({ cwd: "/nonexistent/xyz" }).error, "git history unavailable");
});

test("groupByDay of nothing is empty", () => {
  assert.deepEqual(groupByDay([]), []);
});
