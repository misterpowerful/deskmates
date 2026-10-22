import test from "node:test";
import assert from "node:assert/strict";
import { gmailSearch } from "../../src/tools/gmail.js";
import { getGoogleAccessToken } from "../../src/tools/googleAuth.js";

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
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === "function" ? r() : r.clone();
  };
  return calls;
}

async function withToken() {
  stub([resp(200, { access_token: "t", expires_in: 3600 })]);
  await getGoogleAccessToken();
}

test("gmailSearch tolerates a missing resultSizeEstimate field by falling back to what actually came back, never truncated", async () => {
  await withToken();
  stub([resp(200, { messages: [{ id: "m1" }] }), resp(200, { id: "m1", payload: { headers: [] } })]);
  const result = await gmailSearch({ query: "x" });
  assert.equal(result.results.length, 1);
  assert.equal(result.resultSizeEstimate, 1);
  assert.equal(result.truncated, false);
});

test("gmailSearch tolerates a missing messages array (empty mailbox match) without crashing", async () => {
  await withToken();
  stub([resp(200, {})]);
  const result = await gmailSearch({ query: "x" });
  assert.deepEqual(result, { results: [], resultSizeEstimate: 0, truncated: false });
});

test("gmailSearch does not report truncated when the API sends a non-numeric resultSizeEstimate", async () => {
  await withToken();
  stub([resp(200, { messages: [{ id: "m1" }], resultSizeEstimate: "lots" }), resp(200, { id: "m1", payload: { headers: [] } })]);
  const result = await gmailSearch({ query: "x" });
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, false);
});

test("gmailSearch reports truncated when the API sends resultSizeEstimate as a numeric string larger than the page", async () => {
  await withToken();
  stub([resp(200, { messages: [{ id: "m1" }], resultSizeEstimate: "99" }), resp(200, { id: "m1", payload: { headers: [] } })]);
  const result = await gmailSearch({ query: "x" });
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, true);
});

test("gmailSearch surfaces a Gmail API failure on the list call as an error instead of swallowing it", async () => {
  await withToken();
  stub([resp(500, { error: "boom" })]);
  await assert.rejects(() => gmailSearch({ query: "x" }));
});

test("gmailSearch keeps the messages that fetched fine when one of several detail fetches rejects", async () => {
  await withToken();
  stub([
    resp(200, { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
    resp(200, { id: "m1", payload: { headers: [] } }),
    resp(404, { error: "not found" }),
    resp(200, { id: "m3", payload: { headers: [] } }),
  ]);
  const result = await gmailSearch({ query: "x" });
  assert.deepEqual(
    result.results.map((r) => r.id),
    ["m1", "m3"],
  );
  assert.equal(result.resultSizeEstimate, 3);
  assert.equal(result.truncated, true);
});

test("gmailSearch returns an empty result set (not a rejection) when every detail fetch fails", async () => {
  await withToken();
  stub([
    resp(200, { messages: [{ id: "m1" }, { id: "m2" }] }),
    resp(404, { error: "not found" }),
    resp(404, { error: "not found" }),
  ]);
  const result = await gmailSearch({ query: "x" });
  assert.deepEqual(result.results, []);
  assert.equal(result.truncated, true);
});

test("gmailSearch encodes a hostile query string (quotes, ampersands, newlines) into the request URL safely", async () => {
  await withToken();
  const hostileQuery = 'from:"a&b" OR subject:<script>\nis:unread';
  const calls = stub([resp(200, {})]);
  await gmailSearch({ query: hostileQuery });
  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("q"), hostileQuery);
});
