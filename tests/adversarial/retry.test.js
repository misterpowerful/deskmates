import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, isTransientError } from "../../src/retry.js";

test("permanent errors are not retried", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw Object.assign(new Error("no"), { status }); }, { sleep: async () => {} }),
    );
    assert.equal(calls, 1, `status ${status}`);
  }
});

test("garbage thrown values are permanent and rethrown as-is", async () => {
  for (const bad of [null, undefined, "str", 42]) {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw bad; }, { sleep: async () => {} }),
      (e) => e === bad,
    );
    assert.equal(calls, 1);
    assert.equal(isTransientError(bad), false);
  }
});

test("errors with unrelated names/codes and non-numeric status are not transient", () => {
  assert.equal(isTransientError(new Error("boom")), false);
  assert.equal(isTransientError({ status: "503" }), false);
  assert.equal(isTransientError({ code: 500 }), false);
  assert.equal(isTransientError(new TypeError("bad arg")), false);
});

test("retries: 0 disables retrying", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw Object.assign(new Error("x"), { status: 503 }); }, { retries: 0, sleep: async () => {} }),
  );
  assert.equal(calls, 1);
});

test("retryMethods does not retry permanent errors and throws on bad paths", async () => {
  const { retryMethods } = await import("../../src/retry.js");
  let calls = 0;
  const c = { f: async () => { calls++; throw Object.assign(new Error("bad"), { status: 401 }); } };
  retryMethods(c, ["f"], "L", () => assert.fail("must not log"));
  await assert.rejects(c.f(), /bad/);
  assert.equal(calls, 1);
  assert.throws(() => retryMethods({}, ["a.b"], "L"));
});
