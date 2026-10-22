// Recent code changes for the webapp's Changes view: the repo's own commit
// history (current checkout, HEAD only), grouped by day and tagged as day or
// overnight work. Read-only — only ever runs `git log`.

import { execFileSync } from "node:child_process";

const FIELD = "\x1f";
const RECORD = "\x1e";
const MAX_DAYS = 90;
const MAX_COMMITS = 500;
// Commits authored 00:00-05:59 (author's local clock) count as "night".
const NIGHT_END_HOUR = 6;

export function clampDays(days) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, MAX_DAYS);
}

// Parses `git log --format=%H<FS>%aI<FS>%an<FS>%s<RS>` output. Malformed
// records are skipped rather than thrown on.
export function parseGitLog(raw) {
  if (typeof raw !== "string") return [];
  const commits = [];
  for (const rec of raw.split(RECORD)) {
    const [hash, date, author, ...rest] = rec.trim().split(FIELD);
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(date ?? "");
    if (!m || !/^[0-9a-f]{7,64}$/.test(hash ?? "")) continue;
    commits.push({
      hash,
      short: hash.slice(0, 7),
      date: m[1],
      time: date.slice(11, 16),
      night: Number(m[2]) < NIGHT_END_HOUR,
      author: author ?? "",
      subject: rest.join(FIELD),
    });
  }
  return commits;
}

// Newest day first; commits keep their incoming (newest-first) order.
export function groupByDay(commits) {
  const days = new Map();
  for (const c of commits) {
    if (!days.has(c.date)) days.set(c.date, []);
    days.get(c.date).push(c);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => ({ date, commits: list }));
}

export function recentChanges({ cwd = process.cwd(), days = 7 } = {}) {
  const span = clampDays(days);
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["log", `--since=${span} days ago`, `--max-count=${MAX_COMMITS}`, `--format=%H${FIELD}%aI${FIELD}%an${FIELD}%s${RECORD}`],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { days: [], error: "git history unavailable" };
  }
  return { days: groupByDay(parseGitLog(raw)), error: null };
}
