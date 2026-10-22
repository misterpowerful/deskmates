import test from "node:test";
import assert from "node:assert/strict";
import { calendarListEvents, withZoneOffset } from "../../src/tools/calendar.js";
import { getGoogleAccessToken } from "../../src/tools/googleAuth.js";

process.env.GOOGLE_CLIENT_ID = "a";
process.env.GOOGLE_CLIENT_SECRET = "b";
process.env.GOOGLE_REFRESH_TOKEN = "c";

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});
const resp = (status, body = {}) => new Response(JSON.stringify(body), { status });

test("a local wall-clock time gets its zone's offset, as Google's events.list requires", () => {
  assert.equal(withZoneOffset("2026-10-19T00:00:00", "America/Chicago"), "2026-10-19T00:00:00-05:00");
  assert.equal(withZoneOffset("2026-01-15T09:30:00", "America/Chicago"), "2026-01-15T09:30:00-06:00");
  assert.equal(withZoneOffset("2026-07-01T12:00:00", "Asia/Kolkata"), "2026-07-01T12:00:00+05:30");
});

test("calendarListEvents sends offset-bearing timeMin/timeMax for local times (the 2026-10-18 400s)", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? resp(200, { access_token: "t", expires_in: 3600 }) : resp(200, { items: [] });
  };
  await getGoogleAccessToken();
  await calendarListEvents({ time_min: "2026-10-19T00:00:00", time_max: "2026-10-20T00:00:00", timeZone: "America/Chicago" });
  const url = new URL(calls.at(-1));
  assert.equal(url.searchParams.get("timeMin"), "2026-10-19T00:00:00-05:00");
  assert.equal(url.searchParams.get("timeMax"), "2026-10-20T00:00:00-05:00");
  assert.equal(url.searchParams.get("timeZone"), "America/Chicago");
});
