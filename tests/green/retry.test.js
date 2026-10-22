import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, isTransientError, MAX_RETRIES } from "../../src/retry.js";

const noSleep = (delays) => async (ms) => void delays.push(ms);

test("returns first success without retrying", async () => {
  let calls = 0;
  assert.equal(await withRetry(async () => (++calls, "ok"), { sleep: noSleep([]) }), "ok");
  assert.equal(calls, 1);
});

test("retries transient errors with exponential backoff then succeeds", async () => {
  const delays = [];
  const seen = [];
  let calls = 0;
  const out = await withRetry(
    async () => {
      if (++calls < 4) throw Object.assign(new Error("busy"), { status: 503 });
      return "done";
    },
    { sleep: noSleep(delays), onRetry: (e, n, d) => seen.push([n, d]) },
  );
  assert.equal(out, "done");
  assert.equal(calls, 4);
  assert.deepEqual(delays, [250, 500, 1000]);
  assert.deepEqual(seen, [[1, 250], [2, 500], [3, 1000]]);
});

test("gives up after MAX_RETRIES and rethrows last error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw Object.assign(new Error("x"), { status: 500 }); }, { sleep: noSleep([]) }),
    /x/,
  );
  assert.equal(calls, MAX_RETRIES + 1);
});

test("default sleep works with tiny base delay", async () => {
  let calls = 0;
  await withRetry(async () => { if (++calls < 2) throw Object.assign(new Error("r"), { statusCode: 429 }); }, { baseDelayMs: 1 });
  assert.equal(calls, 2);
});

test("isTransientError classifies statuses, codes and names", () => {
  assert.ok(isTransientError({ status: 429 }));
  assert.ok(isTransientError({ statusCode: 502 }));
  assert.ok(isTransientError({ code: "ECONNRESET" }));
  assert.ok(isTransientError({ cause: { code: "ETIMEDOUT" } }));
  assert.ok(isTransientError({ name: "APIConnectionError" }));
  assert.ok(isTransientError(Object.assign(new TypeError("fetch failed"))));
  assert.ok(!isTransientError({ status: 400 }));
});

test("retryMessage describes the retry", async () => {
  const { retryMessage } = await import("../../src/retry.js");
  assert.equal(retryMessage("Claude call", new Error("boom"), 2, 500), "Claude call failed transiently (boom); retry 2 in 500ms");
  assert.match(retryMessage("x", null, 1, 250), /null/);
});

test("retryMethods wraps nested methods, keeps this, retries and logs", async () => {
  const { retryMethods } = await import("../../src/retry.js");
  const logs = [];
  let calls = 0;
  const client = {
    tag: "t",
    inner: {
      tag: "inner",
      async go(x) {
        if (++calls < 3) throw Object.assign(new Error("flaky"), { status: 503 });
        return `${this.tag}:${x}`;
      },
    },
  };
  assert.equal(retryMethods(client, ["inner.go"], "Lbl", (m) => logs.push(m), { baseDelayMs: 1 }), client);
  assert.equal(await client.inner.go("a"), "inner:a");
  assert.equal(calls, 3);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^Lbl failed transiently \(flaky\); retry 1 in 1ms/);
});

test("retryMethods works without a log function", async () => {
  const { retryMethods } = await import("../../src/retry.js");
  let calls = 0;
  const c = { f: async () => { if (++calls < 2) throw Object.assign(new Error("e"), { status: 500 }); return 1; } };
  retryMethods(c, ["f"], "L", undefined, { baseDelayMs: 1 });
  assert.equal(await c.f(), 1);
});
