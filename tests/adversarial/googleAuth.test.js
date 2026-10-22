import test from "node:test";
import assert from "node:assert/strict";
import { readRetryOptions } from "../../src/tools/http.js";
import { getGoogleAccessToken } from "../../src/tools/googleAuth.js";

readRetryOptions.baseDelayMs = 1;

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(...statuses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status });
  };
  return calls;
}

// Runs before any token is cached, so every call here hits the network stub.
test("token refresh without OAuth config fails without calling fetch", async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  const calls = stub(200);
  await assert.rejects(getGoogleAccessToken(), /not configured/);
  assert.equal(calls.length, 0);
});

test("a permanent token refresh failure (401) is reported, not retried", async () => {
  process.env.GOOGLE_CLIENT_ID = "a";
  process.env.GOOGLE_CLIENT_SECRET = "b";
  process.env.GOOGLE_REFRESH_TOKEN = "c";
  const calls = stub(401);
  await assert.rejects(getGoogleAccessToken(), /token refresh failed \(401\)/);
  assert.equal(calls.length, 1);
});

test("a persistent 503 on token refresh is retried then reported", async () => {
  const calls = stub(503);
  await assert.rejects(getGoogleAccessToken(), /token refresh failed \(503\)/);
  assert.equal(calls.length, 4);
});
