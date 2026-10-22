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

function makeMessage(i) {
  return {
    id: `m${i}`,
    snippet: `Snippet ${i}`,
    payload: {
      headers: [
        { name: "Subject", value: `Subject ${i}` },
        { name: "From", value: `sender${i}@example.com` },
        { name: "Date", value: `2026-01-0${i}T10:00:00Z` },
      ],
    },
  };
}

test("gmailSearch returns results and truncated:false when resultSizeEstimate matches what came back", async () => {
  await withToken();
  const calls = stub([
    resp(200, { messages: [{ id: "m1" }, { id: "m2" }], resultSizeEstimate: 2 }),
    resp(200, makeMessage(1)),
    resp(200, makeMessage(2)),
  ]);
  const result = await gmailSearch({ query: "is:unread" });
  assert.deepEqual(result, {
    results: [
      { id: "m1", snippet: "Snippet 1", subject: "Subject 1", from: "sender1@example.com", date: "2026-01-01T10:00:00Z" },
      { id: "m2", snippet: "Snippet 2", subject: "Subject 2", from: "sender2@example.com", date: "2026-01-02T10:00:00Z" },
    ],
    resultSizeEstimate: 2,
    truncated: false,
  });
  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("maxResults"), "10");
  assert.equal(listUrl.searchParams.get("q"), "is:unread");
});

test("gmailSearch preserves message order and includes every result when all detail fetches succeed", async () => {
  await withToken();
  stub([
    resp(200, { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }], resultSizeEstimate: 3 }),
    resp(200, makeMessage(1)),
    resp(200, makeMessage(2)),
    resp(200, makeMessage(3)),
  ]);
  const result = await gmailSearch({ query: "is:unread" });
  assert.deepEqual(
    result.results.map((r) => r.id),
    ["m1", "m2", "m3"],
  );
  assert.equal(result.truncated, false);
});

test("gmailSearch reports truncated:true when resultSizeEstimate exceeds the capped page of results", async () => {
  await withToken();
  const messages = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}` }));
  const messageResponses = Array.from({ length: 10 }, (_, i) => resp(200, makeMessage(i)));
  stub([resp(200, { messages, resultSizeEstimate: 43 }), ...messageResponses]);
  const result = await gmailSearch({ query: "is:unread" });
  assert.equal(result.results.length, 10);
  assert.equal(result.resultSizeEstimate, 43);
  assert.equal(result.truncated, true);
});
