import test from "node:test";
import assert from "node:assert/strict";
import { readRetryOptions, fetchWithTimeout } from "../../src/tools/http.js";
import { githubReadFile, githubWriteFile, githubListCommits } from "../../src/tools/github.js";
import { gmailMarkRead } from "../../src/tools/gmail.js";
import { calendarCreateEvent } from "../../src/tools/calendar.js";
import { getGoogleAccessToken } from "../../src/tools/googleAuth.js";
import { isTransientError } from "../../src/retry.js";

readRetryOptions.baseDelayMs = 1;
process.env.GITHUB_PAT = "x";
process.env.GOOGLE_CLIENT_ID = "a";
process.env.GOOGLE_CLIENT_SECRET = "b";
process.env.GOOGLE_REFRESH_TOKEN = "c";

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const resp = (status, body = {}) => new Response(JSON.stringify(body), { status });

function stub(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return responses[Math.min(calls.length - 1, responses.length - 1)].clone();
  };
  return calls;
}

test("github write is not retried on 503", async () => {
  const calls = stub([resp(503), resp(200, {})]);
  await assert.rejects(githubWriteFile({ owner: "o", repo: "r", path: "p", content: "c", message: "m" }), /503/);
  assert.equal(calls.length, 1);
});

test("github write rejects content over the size cap before any request", async () => {
  const calls = stub([resp(200, {})]);
  const oversized = "x".repeat(1024 * 1024 + 1);
  await assert.rejects(
    githubWriteFile({ owner: "o", repo: "r", path: "p", content: oversized, message: "m" }),
    /content exceeds 1024kb limit/,
  );
  assert.equal(calls.length, 0);
});

test("gmail mark-read and calendar create are not retried on 503", async () => {
  stub([resp(200, { access_token: "t", expires_in: 3600 })]);
  await getGoogleAccessToken();
  let calls = stub([resp(503), resp(200, {})]);
  await assert.rejects(gmailMarkRead({ message_id: "m" }), /503/);
  assert.equal(calls.length, 1);
  calls = stub([resp(503), resp(200, {})]);
  await assert.rejects(calendarCreateEvent({ summary: "s", start: "a", end: "b" }), /503/);
  assert.equal(calls.length, 1);
});

test("permanent read errors (404) are not retried", async () => {
  const calls = stub([resp(404), resp(200, {})]);
  await assert.rejects(githubReadFile({ owner: "o", repo: "r", path: "p" }), /404/);
  assert.equal(calls.length, 1);
});

test("persistent 503 on a read gives up after retries", async () => {
  const calls = stub([resp(503)]);
  await assert.rejects(githubReadFile({ owner: "o", repo: "r", path: "p" }), /503/);
  assert.equal(calls.length, 4);
});

test("a write whose fetch hangs times out with a clear error, without retry", async () => {
  let n = 0;
  globalThis.fetch = (url, { signal }) => {
    n++;
    return new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 1000); // AbortSignal.timeout is unref'd
      signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      });
    });
  };
  await assert.rejects(
    fetchWithTimeout("http://x", { method: "PUT" }, { timeoutMs: 10, label: "GitHub" }),
    (e) => e.name === "TimeoutError" && /GitHub request timed out after 0.01s/.test(e.message),
  );
  assert.equal(n, 1);
});

test("github list commits refuses missing/invalid owner or repo before any request", async () => {
  const calls = stub([resp(200, [])]);
  for (const input of [
    {},
    { owner: "o" },
    { repo: "r" },
    { owner: "", repo: "r" },
    { owner: "o", repo: "" },
    { owner: 42, repo: "r" },
    { owner: "o", repo: {} },
    { owner: null, repo: "r" },
    { owner: "o", repo: ["r"] },
  ]) {
    await assert.rejects(githubListCommits(input), /owner and repo are required/);
  }
  await assert.rejects(githubListCommits(), /owner and repo are required/);
  await assert.rejects(githubListCommits(undefined), /owner and repo are required/);
  assert.equal(calls.length, 0);
});

test("github list commits clamps a hostile limit into range and never over-fetches", async () => {
  for (const limit of [999999, Infinity, -5, 0, NaN, "20", null, {}, [], 3.9]) {
    const calls = stub([resp(200, Array.from({ length: 25 }, (_, i) => ({ sha: `s${i}`, commit: {} })))]);
    await githubListCommits({ owner: "o", repo: "r", limit });
    const perPageMatch = calls[0].url.match(/per_page=(\d+)/);
    assert.ok(perPageMatch, `no per_page in ${calls[0].url}`);
    const perPage = Number(perPageMatch[1]);
    assert.ok(perPage >= 1 && perPage <= 20, `limit ${limit} produced per_page=${perPage}`);
    // one list request + at most 20 detail requests, regardless of how many
    // commits GitHub claims are in range.
    assert.ok(calls.length <= 21, `limit ${limit} caused ${calls.length} requests`);
  }
});

test("github list commits truncates an oversized or ignores a non-string since", async () => {
  const huge = "x".repeat(10_000);
  let calls = stub([resp(200, [])]);
  await githubListCommits({ owner: "o", repo: "r", since: huge });
  assert.ok(calls[0].url.length < 1000, `since was not truncated: ${calls[0].url.length} chars`);

  for (const since of [12345, {}, [], true, new Date()]) {
    calls = stub([resp(200, [])]);
    const before = Date.now();
    const result = await githubListCommits({ owner: "o", repo: "r", since });
    const sinceMs = new Date(result.since).getTime();
    assert.ok(Math.abs(before - 24 * 60 * 60 * 1000 - sinceMs) < 5000, `non-string since ${String(since)} was not ignored`);
  }
});

test("github list commits skips a commit entry with no sha instead of crashing", async () => {
  const detailA = { sha: "a1", commit: { message: "m", author: { name: "A", date: "d" } }, files: [] };
  const calls = stub([
    resp(200, [{ sha: "a1", commit: {} }, { commit: { message: "no sha" } }, { sha: null }]),
    resp(200, detailA),
  ]);
  const result = await githubListCommits({ owner: "o", repo: "r" });
  assert.equal(result.count, 1);
  assert.equal(result.commits[0].sha, "a1");
  assert.equal(calls.length, 2); // only the one valid commit gets a detail fetch
});

test("github list commits does not retry a permanent 404 on the list call, and fetches no details", async () => {
  const calls = stub([resp(404, { message: "Not Found" })]);
  await assert.rejects(githubListCommits({ owner: "o", repo: "r" }), /404/);
  assert.equal(calls.length, 1);
});

test("github list commits rejects a non-array response body cleanly", async () => {
  const calls = stub([resp(200, { message: "not a list" })]);
  await assert.rejects(githubListCommits({ owner: "o", repo: "r" }), /Unexpected response/);
  assert.equal(calls.length, 1);
});

test("non-timeout fetch errors pass through unchanged", async () => {
  globalThis.fetch = async () => {
    throw new RangeError("boom");
  };
  await assert.rejects(fetchWithTimeout("http://x"), RangeError);
});

test("isTransientError recognizes AbortError and TimeoutError", () => {
  assert.ok(isTransientError(Object.assign(new Error("a"), { name: "AbortError" })));
  assert.ok(isTransientError(Object.assign(new Error("t"), { name: "TimeoutError" })));
});
