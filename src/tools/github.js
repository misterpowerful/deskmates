// GitHub REST API, full read/write, across every repository the token can
// see — not scoped to deskmates alone (deliberate; see the tool build task).
// Auth: GITHUB_PAT, a fine-grained PAT with "Contents: Read and write" on
// every repo it should touch. Distinct from GITHUB_TOKEN (used only for this
// repo's own git-push credential storage, see .git/deskmates-credentials) —
// different purpose, deliberately not reused here.

import { fetchWithTimeout, retryRead, statusError } from "./http.js";

const GITHUB_API = "https://api.github.com";
const MAX_LIST_REPOS_PAGES = 5;

// Bounds github_list_commits: the list call itself asks for at most this
// many, and each one costs a second request (see githubListCommits) to get
// its files — so this also caps total requests per call at MAX_COMMITS + 1,
// regardless of what a caller passes as `limit`.
const MAX_COMMITS = 20;
const DEFAULT_COMMITS = 10;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Real `since` values are short ISO-8601 timestamps; this just keeps a
// hostile/oversized string from producing a degenerate request.
const MAX_SINCE_LENGTH = 100;
// Per-commit file list is capped independently of MAX_COMMITS, so one giant
// merge commit in the window can't blow up the response.
const MAX_FILES_PER_COMMIT = 30;
// Generous for any real source file in this repo; mainly guards against a
// runaway/hallucinated proposal (e.g. repeated content) turning into a huge
// PUT that fails opaquely on GitHub's side instead of here.
const MAX_CONTENT_BYTES = 1024 * 1024;

function authHeaders() {
  const token = process.env.GITHUB_PAT;
  if (!token) {
    throw new Error("GITHUB_PAT is not set in .env — see README.md for how to create one");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodeRepoPath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function githubFetch(url, options) {
  return fetchWithTimeout(url, options, { label: "GitHub" });
}

export async function githubReadFile({ owner, repo, path: filePath }) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeRepoPath(filePath)}`;
  const data = await retryRead(async () => {
    const res = await githubFetch(url, { headers: authHeaders() });
    if (!res.ok) {
      throw statusError(`GitHub read failed (${res.status}): ${await res.text()}`, res.status);
    }
    return res.json();
  });
  if (Array.isArray(data)) {
    throw new Error(`${filePath} is a directory, not a file`);
  }
  const content = Buffer.from(data.content, data.encoding ?? "base64").toString("utf8");
  return { content, sha: data.sha };
}

export async function githubWriteFile({ owner, repo, path: filePath, content, message, sha }) {
  const contentBytes = Buffer.byteLength(content ?? "", "utf8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    throw new Error(`content exceeds ${MAX_CONTENT_BYTES / 1024}kb limit (${Math.ceil(contentBytes / 1024)}kb)`);
  }
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeRepoPath(filePath)}`;
  const res = await githubFetch(url, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub write failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return { sha: data.content?.sha, commitUrl: data.commit?.html_url };
}

export async function githubListRepos() {
  const repos = [];
  for (let page = 1; page <= MAX_LIST_REPOS_PAGES; page++) {
    const url = `${GITHUB_API}/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`;
    const data = await retryRead(async () => {
      const res = await githubFetch(url, { headers: authHeaders() });
      if (!res.ok) {
        throw statusError(`GitHub list repos failed (${res.status}): ${await res.text()}`, res.status);
      }
      return res.json();
    });
    repos.push(
      ...data.map((r) => ({
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
      })),
    );
    if (data.length < 100) break;
  }
  return repos;
}

// Clamps `limit` to a positive integer within [1, MAX_COMMITS], falling
// back to DEFAULT_COMMITS for anything not a plain finite number (missing,
// NaN, Infinity, a string, an object, ...) so a hostile or malformed value
// can never grow the number of requests this makes.
function normalizeCommitLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_COMMITS;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_COMMITS);
}

// Falls back to the last 24h when `since` is missing or not a usable
// string; truncates anything absurdly long rather than sending it to
// GitHub as-is. An unparseable-but-plausible-length value is still passed
// through — GitHub itself will reject it and that surfaces as a normal
// statusError, same as any other bad-input read.
function normalizeSince(since) {
  if (typeof since !== "string") return null;
  const trimmed = since.trim().slice(0, MAX_SINCE_LENGTH);
  return trimmed || null;
}

export async function githubListCommits({ owner, repo, since, limit } = {}) {
  if (typeof owner !== "string" || !owner.trim() || typeof repo !== "string" || !repo.trim()) {
    throw new Error("owner and repo are required");
  }
  const perPage = normalizeCommitLimit(limit);
  const sinceIso = normalizeSince(since) ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const listUrl = `${base}/commits?since=${encodeURIComponent(sinceIso)}&per_page=${perPage}`;

  const list = await retryRead(async () => {
    const res = await githubFetch(listUrl, { headers: authHeaders() });
    if (!res.ok) {
      throw statusError(`GitHub list commits failed (${res.status}): ${await res.text()}`, res.status);
    }
    return res.json();
  });
  if (!Array.isArray(list)) {
    throw new Error("Unexpected response from GitHub commits API");
  }

  const commits = [];
  for (const item of list.slice(0, perPage)) {
    if (!item?.sha) continue;
    const detail = await retryRead(async () => {
      const res = await githubFetch(`${base}/commits/${encodeURIComponent(item.sha)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        throw statusError(`GitHub read commit failed (${res.status}): ${await res.text()}`, res.status);
      }
      return res.json();
    });
    const files = Array.isArray(detail.files) ? detail.files : [];
    commits.push({
      sha: item.sha,
      message: detail.commit?.message ?? item.commit?.message ?? "",
      author: detail.commit?.author?.name || detail.author?.login || "unknown",
      date: detail.commit?.author?.date ?? item.commit?.author?.date ?? null,
      filesChanged: files.length,
      files: files.slice(0, MAX_FILES_PER_COMMIT).map((f) => f.filename),
      url: detail.html_url ?? item.html_url ?? null,
    });
  }

  return { owner, repo, since: sinceIso, count: commits.length, commits };
}
