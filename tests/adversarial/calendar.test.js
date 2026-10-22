import test from "node:test";
import assert from "node:assert/strict";
import { calendarListEvents, calendarCreateEvent } from "../../src/tools/calendar.js";
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

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    summary: `Event ${i}`,
    start: { dateTime: "2026-01-01T10:00:00Z" },
    end: { dateTime: "2026-01-01T11:00:00Z" },
  }));
}

test("calendarListEvents clamps a hostile maxResults into range and never asks Google for more than the cap", async () => {
  for (const maxResults of [999999, Infinity, -5, 0, NaN, "20", null, {}, [], 3.9]) {
    await withToken();
    const calls = stub([resp(200, { items: makeItems(60) })]);
    const result = await calendarListEvents({ time_min: "a", time_max: "b", maxResults });
    const requestedMatch = new URL(calls[0].url).searchParams.get("maxResults");
    const requested = Number(requestedMatch);
    assert.ok(requested >= 1 && requested <= 50, `maxResults ${maxResults} produced request maxResults=${requestedMatch}`);
    assert.ok(result.events.length <= 50, `maxResults ${maxResults} returned ${result.events.length} events`);
  }
});

test("calendarListEvents reports truncated when Google's response fills the cap", async () => {
  await withToken();
  stub([resp(200, { items: makeItems(50) })]);
  const result = await calendarListEvents({ time_min: "a", time_max: "b" });
  assert.equal(result.events.length, 25);
  assert.equal(result.truncated, true);
});

test("calendarListEvents does not report truncated when the response is under the cap", async () => {
  await withToken();
  stub([resp(200, { items: makeItems(3) })]);
  const result = await calendarListEvents({ time_min: "a", time_max: "b" });
  assert.equal(result.events.length, 3);
  assert.equal(result.truncated, false);
});

test("calendarListEvents tolerates a missing items array", async () => {
  await withToken();
  stub([resp(200, {})]);
  const result = await calendarListEvents({ time_min: "a", time_max: "b" });
  assert.deepEqual(result, { events: [], truncated: false });
});

test("calendarCreateEvent falls back to config.default_timezone when timeZone is missing or invalid, instead of erroring", async () => {
  for (const timeZone of [undefined, null, "", "Not/AZone", 123, {}, []]) {
    await withToken();
    const calls = stub([resp(200, { id: "evt1", htmlLink: "https://calendar.google.com/evt1" })]);
    const result = await calendarCreateEvent(
      { summary: "S", start: "2026-10-14T14:00:00", end: "2026-10-14T15:00:00", timeZone },
      { default_timezone: "America/Chicago" },
    );
    assert.deepEqual(result, { id: "evt1", htmlLink: "https://calendar.google.com/evt1" });
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.start.timeZone, "America/Chicago", `timeZone ${JSON.stringify(timeZone)} did not fall back cleanly`);
    assert.equal(body.end.timeZone, "America/Chicago");
  }
});

test("calendarCreateEvent falls back all the way to UTC when both timeZone and config.default_timezone are missing/invalid", async () => {
  for (const config of [{}, { default_timezone: "Not/AZone" }, { default_timezone: 123 }]) {
    await withToken();
    const calls = stub([resp(200, { id: "evt1", htmlLink: "https://calendar.google.com/evt1" })]);
    await calendarCreateEvent(
      { summary: "S", start: "2026-10-14T14:00:00", end: "2026-10-14T15:00:00", timeZone: "also/bogus" },
      config,
    );
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.start.timeZone, "UTC");
    assert.equal(body.end.timeZone, "UTC");
  }
});

test("calendarListEvents falls back to config.default_timezone or UTC when timeZone is missing/invalid, instead of erroring", async () => {
  await withToken();
  let calls = stub([resp(200, { items: [] })]);
  await calendarListEvents({ time_min: "a", time_max: "b", timeZone: undefined }, { default_timezone: "America/Chicago" });
  assert.equal(new URL(calls[0].url).searchParams.get("timeZone"), "America/Chicago");

  await withToken();
  calls = stub([resp(200, { items: [] })]);
  await calendarListEvents({ time_min: "a", time_max: "b", timeZone: "garbage" }, {});
  assert.equal(new URL(calls[0].url).searchParams.get("timeZone"), "UTC");
});
