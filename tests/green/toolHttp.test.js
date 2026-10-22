import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout, readRetryOptions } from "../../src/tools/http.js";
import { githubReadFile, githubWriteFile, githubListRepos, githubListCommits } from "../../src/tools/github.js";
import { gmailReadMessage, gmailMarkRead } from "../../src/tools/gmail.js";
import { calendarListEvents } from "../../src/tools/calendar.js";
import { getGoogleAccessToken } from "../../src/tools/googleAuth.js";

readRetryOptions.baseDelayMs = 1;
process.env.GITHUB_PAT = "x";
process.env.GOOGLE_CLIENT_ID = "a";
process.env.GOOGLE_CLIENT_SECRET = "b";
process.env.GOOGLE_REFRESH_TOKEN = "c";

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const resp = (status, body = {}) =>
  new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status });

function stub(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === "function" ? r() : r.clone();
  };
  return calls;
}

test("github read retries on 503 then succeeds", async () => {
  const content = Buffer.from("hi").toString("base64");
  const calls = stub([resp(503, "down"), resp(200, { content, encoding: "base64", sha: "s" })]);
  assert.deepEqual(await githubReadFile({ owner: "o", repo: "r", path: "a.txt" }), { content: "hi", sha: "s" });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
});

test("github list repos retries on 503", async () => {
  const calls = stub([resp(503), resp(200, [{ full_name: "o/r", private: false, default_branch: "main" }])]);
  assert.equal((await githubListRepos()).length, 1);
  assert.equal(calls.length, 2);
});

test("gmail and calendar reads retry on 503", async () => {
  stub([resp(200, { access_token: "t", expires_in: 3600 })]);
  await getGoogleAccessToken();
  let calls = stub([resp(503), resp(200, { id: "m", payload: {} })]);
  assert.equal((await gmailReadMessage({ message_id: "m" })).id, "m");
  assert.equal(calls.length, 2);
  calls = stub([resp(503), resp(200, { items: [] })]);
  assert.deepEqual(await calendarListEvents({ time_min: "a", time_max: "b" }), { events: [], truncated: false });
  assert.equal(calls.length, 2);
});

test("a hung read fetch times out with a clear error", async () => {
  globalThis.fetch = (url, { signal }) =>
    new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 1000); // AbortSignal.timeout is unref'd
      signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      });
    });
  await assert.rejects(
    fetchWithTimeout("http://x", {}, { timeoutMs: 20, label: "GitHub" }),
    /GitHub request timed out after 0.02s/,
  );
});

test("gmail mark-read success is a single non-retried call", async () => {
  const calls = stub([resp(204, "")]);
  assert.deepEqual(await gmailMarkRead({ message_id: "m" }), { ok: true, message_id: "m" });
  assert.equal(calls.length, 1);
});

test("github list commits fetches message/author/date/files for each commit", async () => {
  const listBody = [
    { sha: "a1", commit: { message: "fallback msg", author: { name: "Fallback", date: "2026-09-20T00:00:00Z" } } },
    { sha: "b2", commit: { message: "fallback msg 2", author: { name: "Fallback2", date: "2026-09-20T01:00:00Z" } } },
  ];
  const detailA = {
    sha: "a1",
    commit: { message: "Fix drawer bug", author: { name: "Alice", date: "2026-09-21T10:00:00Z" } },
    files: [{ filename: "src/a.js" }, { filename: "src/b.js" }],
    html_url: "https://github.com/o/r/commit/a1",
  };
  const detailB = {
    sha: "b2",
    commit: { message: "Update README", author: { name: "Bob", date: "2026-09-21T11:00:00Z" } },
    files: [{ filename: "README.md" }],
    html_url: "https://github.com/o/r/commit/b2",
  };
  const calls = stub([resp(200, listBody), resp(200, detailA), resp(200, detailB)]);
  const result = await githubListCommits({ owner: "o", repo: "r", since: "2026-09-20T00:00:00Z", limit: 2 });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/repos\/o\/r\/commits\?since=2026-09-20T00%3A00%3A00Z&per_page=2/);
  assert.equal(calls[1].url, "https://api.github.com/repos/o/r/commits/a1");
  assert.equal(calls[2].url, "https://api.github.com/repos/o/r/commits/b2");
  assert.equal(result.owner, "o");
  assert.equal(result.repo, "r");
  assert.equal(result.since, "2026-09-20T00:00:00Z");
  assert.equal(result.count, 2);
  assert.deepEqual(result.commits, [
    {
      sha: "a1",
      message: "Fix drawer bug",
      author: "Alice",
      date: "2026-09-21T10:00:00Z",
      filesChanged: 2,
      files: ["src/a.js", "src/b.js"],
      url: "https://github.com/o/r/commit/a1",
    },
    {
      sha: "b2",
      message: "Update README",
      author: "Bob",
      date: "2026-09-21T11:00:00Z",
      filesChanged: 1,
      files: ["README.md"],
      url: "https://github.com/o/r/commit/b2",
    },
  ]);
});

test("github list commits defaults to the last 24 hours when since is omitted", async () => {
  const before = Date.now();
  stub([resp(200, [])]);
  const result = await githubListCommits({ owner: "o", repo: "r" });
  const after = Date.now();
  assert.equal(result.count, 0);
  const sinceMs = new Date(result.since).getTime();
  assert.ok(sinceMs >= before - 24 * 60 * 60 * 1000 - 1000 && sinceMs <= after - 24 * 60 * 60 * 1000 + 1000);
});

test("github list commits retries on 503 for both the list and detail requests", async () => {
  const calls = stub([
    resp(503),
    resp(200, [{ sha: "a1", commit: { message: "m", author: { name: "A", date: "d" } } }]),
    resp(503),
    resp(200, { sha: "a1", commit: { message: "m", author: { name: "A", date: "d" } }, files: [] }),
  ]);
  const result = await githubListCommits({ owner: "o", repo: "r" });
  assert.equal(calls.length, 4);
  assert.equal(result.count, 1);
});

test("github write success is a single call", async () => {
  const calls = stub([resp(200, { content: { sha: "n" }, commit: { html_url: "u" } })]);
  assert.deepEqual(await githubWriteFile({ owner: "o", repo: "r", path: "p", content: "c", message: "m" }), {
    sha: "n",
    commitUrl: "u",
  });
  assert.equal(calls.length, 1);
});

test("github write succeeds with content right at the size cap", async () => {
  const calls = stub([resp(200, { content: { sha: "n" }, commit: { html_url: "u" } })]);
  const atCap = "x".repeat(1024 * 1024);
  assert.deepEqual(await githubWriteFile({ owner: "o", repo: "r", path: "p", content: atCap, message: "m" }), {
    sha: "n",
    commitUrl: "u",
  });
  assert.equal(calls.length, 1);
});
