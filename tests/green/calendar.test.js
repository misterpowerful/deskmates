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

function makeEvent(i) {
  return {
    id: `e${i}`,
    summary: `Event ${i}`,
    start: { dateTime: `2026-01-0${i}T10:00:00Z` },
    end: { dateTime: `2026-01-0${i}T11:00:00Z` },
    description: "",
  };
}

test("calendarListEvents returns a plain event list, untruncated when under the cap", async () => {
  await withToken();
  const calls = stub([resp(200, { items: [makeEvent(1), makeEvent(2)] })]);
  const result = await calendarListEvents({ time_min: "2026-01-01T00:00:00Z", time_max: "2026-01-31T00:00:00Z" });
  assert.deepEqual(result, {
    events: [
      { id: "e1", summary: "Event 1", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: "" },
      { id: "e2", summary: "Event 2", start: "2026-01-02T10:00:00Z", end: "2026-01-02T11:00:00Z", description: "" },
    ],
    truncated: false,
  });
  const requestedUrl = new URL(calls[0].url);
  assert.equal(requestedUrl.searchParams.get("maxResults"), "25");
});

test("calendarListEvents honors a caller-supplied maxResults within the cap", async () => {
  await withToken();
  const calls = stub([resp(200, { items: [makeEvent(1)] })]);
  await calendarListEvents({ time_min: "a", time_max: "b", maxResults: 5 });
  const requestedUrl = new URL(calls[0].url);
  assert.equal(requestedUrl.searchParams.get("maxResults"), "5");
});

test("calendarListEvents sends the given IANA timeZone alongside timeMin/timeMax", async () => {
  await withToken();
  const calls = stub([resp(200, { items: [] })]);
  await calendarListEvents({ time_min: "2026-01-01T00:00:00", time_max: "2026-01-31T00:00:00", timeZone: "America/Chicago" });
  const requestedUrl = new URL(calls[0].url);
  assert.equal(requestedUrl.searchParams.get("timeZone"), "America/Chicago");
  // Local wall-clock times go out with the zone's offset: Google rejects them without one (400).
  assert.equal(requestedUrl.searchParams.get("timeMin"), "2026-01-01T00:00:00-06:00");
  assert.equal(requestedUrl.searchParams.get("timeMax"), "2026-01-31T00:00:00-06:00");
});

test("calendarCreateEvent sends a naive local dateTime plus the given IANA timeZone on both start and end", async () => {
  await withToken();
  const calls = stub([resp(200, { id: "evt1", htmlLink: "https://calendar.google.com/evt1" })]);
  const result = await calendarCreateEvent({
    summary: "Dentist",
    start: "2026-10-14T14:00:00",
    end: "2026-10-14T15:00:00",
    description: "Checkup",
    timeZone: "America/Chicago",
  });
  assert.deepEqual(result, { id: "evt1", htmlLink: "https://calendar.google.com/evt1" });
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, {
    summary: "Dentist",
    description: "Checkup",
    start: { dateTime: "2026-10-14T14:00:00", timeZone: "America/Chicago" },
    end: { dateTime: "2026-10-14T15:00:00", timeZone: "America/Chicago" },
  });
});
