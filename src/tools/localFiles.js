// Local filesystem access, sandboxed to this repo's own working tree on
// this server — distinct from github.js, which talks to the GitHub REST API
// for (potentially) any repo on the account. This one only ever reads what's
// actually sitting on disk right now, including anything not yet committed
// or pushed — which matters for files this server writes to at runtime and
// never commits back (personalities/*/memory.json, tasks/*), where
// github_read_file would silently return a stale snapshot instead. Read-only:
// no writes live here.

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

// Never listed, regardless of which directory is requested: .env holds
// live secrets (API keys, the GitHub PAT itself — see .gitignore), .git is
// plumbing, node_modules is noise no conversation needs, logs holds
// verbatim transcripts of past conversations (turns.db/turns.jsonl, see
// turnLog.js) and job-run logs — never meant to be conversationally
// accessible even though these tools are reachable from ordinary chat.
const HIDDEN_ENTRIES = new Set([".env", ".env.local", ".git", "node_modules", "logs"]);

// Containment is checked twice on purpose: once on the lexical path, and
// again on the fully symlink-resolved path. Checking only the lexical form
// is bypassable — a symlink inside the tree ("notes.txt" -> ".env") passes
// every string check while the subsequent read follows the link to the real
// target. Since .env holds live secrets (Anthropic key, the GitHub PAT) and
// this tool is reachable from ordinary conversation in tool-enabled modes,
// the real path is what has to be judged, not the requested one.
//
// realpath is applied to the nearest existing ancestor rather than the
// target itself, so a path that simply doesn't exist still produces a clean
// ENOENT from the caller's own stat() instead of failing here.
async function realpathOfNearestExisting(target) {
  let current = target;
  for (;;) {
    try {
      return { real: await fs.realpath(current), resolvedFrom: current };
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) return { real: current, resolvedFrom: current };
      current = parent;
    }
  }
}

function assertInsideRoot(candidate, relativePath, rootReal) {
  const rel = path.relative(rootReal, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${relativePath}" resolves outside the repository — not allowed.`);
  }
  return rel;
}

async function resolveSafePath(relativePath) {
  const target = path.resolve(ROOT, relativePath || ".");
  const rootReal = await fs.realpath(ROOT);

  // Lexical check first: cheap, and rejects the obvious "../../etc/passwd"
  // case before touching the filesystem.
  assertInsideRoot(target, relativePath, path.resolve(ROOT));

  const { real, resolvedFrom } = await realpathOfNearestExisting(target);
  // Re-attach whatever tail didn't exist yet, so the returned path still
  // points where the caller asked.
  const tail = path.relative(resolvedFrom, target);
  const realTarget = tail ? path.join(real, tail) : real;

  const rel = assertInsideRoot(realTarget, relativePath, rootReal);
  if (containsHiddenSegment(rel)) {
    throw new Error(`Path "${relativePath}" is not readable — contains a hidden/blocked path segment.`);
  }
  return { target: realTarget, rel };
}

// Blocks reading any file that has a hidden/sensitive path segment anywhere
// in it (not just as the immediate directory entry, unlike listLocalDirectory's
// filter) — e.g. "node_modules/foo/.env" or ".git/config" are both refused,
// not just a bare ".env" at the root.
function containsHiddenSegment(relPath) {
  return relPath.split(path.sep).some((segment) => HIDDEN_ENTRIES.has(segment));
}

const MAX_READ_BYTES = 200_000;

export async function listLocalDirectory({ path: dirPath }) {
  const { target, rel } = await resolveSafePath(dirPath);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    throw new Error(`"${dirPath}" is a file, not a directory.`);
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  return {
    path: rel || ".",
    entries: entries
      .filter((entry) => !HIDDEN_ENTRIES.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file",
        path: path.join(rel, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function readLocalFile({ path: filePath }) {
  const { target, rel } = await resolveSafePath(filePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" is not a file.`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`"${filePath}" is ${stat.size} bytes, over the ${MAX_READ_BYTES}-byte read limit.`);
  }
  const content = await fs.readFile(target, "utf8");
  return { path: rel, content };
}
