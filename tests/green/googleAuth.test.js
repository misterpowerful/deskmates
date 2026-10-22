import test from "node:test";
import assert from "node:assert/strict";
import { readRetryOptions } from "../../src/tools/http.js";
import { getGoogleAccessToken } from "../../src/tools/googleAuth.js";

readRetryOptions.baseDelayMs = 1;
process.env.GOOGLE_CLIENT_ID = "a";
process.env.GOOGLE_CLIENT_SECRET = "b";
process.env.GOOGLE_REFRESH_TOKEN = "c";

test("token refresh retries on 503, then succeeds and caches the token", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return n === 1
      ? new Response("down", { status: 503 })
      : new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  };
  try {
    assert.equal(await getGoogleAccessToken(), "tok");
    assert.equal(await getGoogleAccessToken(), "tok");
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
