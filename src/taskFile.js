import fs from "node:fs";
import path from "node:path";

// Minimal parser for the flat frontmatter shape used by tasks/*.md — just
// `key: value` lines between two `---` fences, not a general YAML parser.
// Matches the one shape the task-lifecycle scripts ever write.
export function parseTaskFile(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }
  const [, fmBlock, body] = match;
  const frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  return { frontmatter, body: body.trim() };
}

export function readTaskFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return { ...parseTaskFile(raw), raw, filename: path.basename(filePath) };
}

// Appends a titled note to the end of a task file's raw text — used to
// record a rejection reason, a done outcome, or a failure reason directly
// in the file so its full history travels with it wherever it's moved.
export function appendNote(raw, heading, text) {
  return `${raw.trim()}\n\n---\n${heading}: ${text}\n`;
}

// Lists the *.md task files in a tasks/ subdirectory (ignoring dotfiles like
// .gitkeep), each with its parsed frontmatter — used to build context for
// the ideation job (what's already done/rejected) and to pick the oldest
// pending task.
export function listTaskFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .map((name) => {
      const filePath = path.join(dir, name);
      const { frontmatter, body, raw } = readTaskFile(filePath);
      const stat = fs.statSync(filePath);
      return { filename: name, filePath, frontmatter, body, raw, mtimeMs: stat.mtimeMs };
    });
}

// Oldest-first by frontmatter `created` (ISO timestamp) when present,
// falling back to file mtime — a task with no `created` field (shouldn't
// happen, but a hand-written one could omit it) sorts by disk time instead
// of crashing.
export function sortOldestFirst(tasks) {
  const timeOf = (t) => {
    const created = t.frontmatter.created ? Date.parse(t.frontmatter.created) : NaN;
    return Number.isFinite(created) ? created : t.mtimeMs;
  };
  return [...tasks].sort((a, b) => timeOf(a) - timeOf(b));
}

function slugify(title) {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "task";
}

// Writes a brand-new task file straight into `dir` — used by the
// conversational self-improvement path (src/speechPipeline.js), which,
// unlike run-ideation.js's tasks/proposed/ output, is never authored by a
// Claude Code subprocess picking its own filename. Filename follows the
// same <slug>-<unix-timestamp>.md scheme run-ideation.js's prompt asks
// Claude to use, with a numeric suffix on the rare collision (two
// proposals landing in the same second). Returns the path written so the
// caller can log/commit it.
export function writeTaskFile(dir, { source, title: rawTitle, description }) {
  fs.mkdirSync(dir, { recursive: true });
  // Frontmatter is line-based: a newline in the title would inject extra keys.
  const title = String(rawTitle ?? "").replace(/\s+/g, " ").trim();
  const slug = slugify(title);
  const ts = Math.floor(Date.now() / 1000);
  let filename = `${slug}-${ts}.md`;
  for (let n = 2; fs.existsSync(path.join(dir, filename)); n++) {
    filename = `${slug}-${ts}-${n}.md`;
  }
  const raw = `---\nsource: ${source}\ncreated: ${new Date().toISOString()}\ntitle: ${title}\n---\n\n${(description ?? "").trim()}\n`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, raw);
  return { filePath, filename };
}
