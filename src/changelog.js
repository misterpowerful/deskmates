// Backs the webapp's "Latest Changes" menu item: a small, hand-curated
// CHANGELOG.md at the repo root (not git history — see src/changes.js for
// that) rendered newest-first. Read-only, no shell-out, no user-supplied
// path — the file name is always the repo's own CHANGELOG.md.

import fs from "node:fs";
import path from "node:path";

// A changelog this large means something is wrong upstream; read at most
// this many bytes regardless of the file's actual size so a runaway or
// hostile file can't be read fully into memory.
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;
const MAX_ITEMS_PER_ENTRY = 200;

// Reads up to `maxBytes` of a file without loading anything beyond that,
// even if the file itself is far larger.
function readCapped(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// Parses `## <heading>` sections from changelog markdown. Each section
// becomes one entry; `- ` / `* ` bullet lines under it become its items.
// A heading's leading `YYYY-MM-DD` (if present) is used to sort entries
// newest-first regardless of the order they appear in the file — an
// out-of-order or hand-edited file still renders correctly. Entries
// without a parseable date sort after every dated entry, keeping their
// relative order.
export function parseChangelog(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const lines = raw.split(/\r\n|\r|\n/);
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (entries.length >= MAX_ENTRIES) break;
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[1].trim();
      if (!text) {
        current = null;
        continue;
      }
      const dated = /^(\d{4}-\d{2}-\d{2})\b\s*(?:[—–-]\s*)?(.*)$/.exec(text);
      current = dated
        ? { date: dated[1], title: dated[2].trim() || dated[1], items: [] }
        : { date: null, title: text, items: [] };
      entries.push(current);
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item && current && current.items.length < MAX_ITEMS_PER_ENTRY) {
      const text = item[1].trim();
      if (text) current.items.push(text);
    }
  }
  return sortNewestFirst(entries);
}

function sortNewestFirst(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.date && b.entry.date) {
        if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? 1 : -1;
        return a.index - b.index;
      }
      if (a.entry.date && !b.entry.date) return -1;
      if (!a.entry.date && b.entry.date) return 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function readChangelog({ cwd = process.cwd(), file = "CHANGELOG.md" } = {}) {
  const filePath = path.join(cwd, file);
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { entries: [], error: "changelog unavailable" };
    raw = readCapped(filePath, MAX_FILE_BYTES);
  } catch {
    return { entries: [], error: "changelog unavailable" };
  }
  return { entries: parseChangelog(raw), error: null };
}
