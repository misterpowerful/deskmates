// Google Calendar: free listing, but creation is gated entirely by the
// model's own judgment via the calendar_create_event tool description (see
// src/tools/index.js) — this module has no explicit-request check of its
// own, because by the time a call reaches here the model has already decided
// to make it.

import { getGoogleAccessToken } from "./googleAuth.js";
import { fetchWithTimeout, retryRead, statusError } from "./http.js";
import { isValidTimezone, resolveTimezone } from "../clientTime.js";
import { readConfig } from "../config.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary";

// start/end (and timeMin/timeMax) are naive local wall-clock strings with no
// UTC offset — the model is never told the person's numeric offset, only a
// human-readable zone tag (see clientTime.js). Google interprets an
// offset-less dateTime as UTC, so without an explicit timeZone alongside it,
// "2pm tomorrow" would silently land at the wrong wall-clock time. A
// missing/invalid timeZone (e.g. a test harness ws with no resolved zone)
// falls back through the exact same precedence resolveTimezone already uses
// for the [TIME: ...] tag, just skipping the IP lookup since this zone was
// already supposed to be resolved once per connection.
function resolveCalendarTimeZone(timeZone, config) {
  return isValidTimezone(timeZone) ? timeZone : resolveTimezone(null, config);
}

// Bounds calendar_list_events: without this, a broad or hostile time range
// falls back to Google's own default page size (250), all of which would
// get serialized into a conversational tool result. Mirrors
// normalizeCommitLimit in github.js.
const MAX_EVENTS = 50;
const DEFAULT_EVENTS = 25;

function normalizeEventLimit(maxResults) {
  if (typeof maxResults !== "number" || !Number.isFinite(maxResults)) return DEFAULT_EVENTS;
  return Math.min(Math.max(Math.trunc(maxResults), 1), MAX_EVENTS);
}

async function authedFetchOnce(url, options) {
  const token = await getGoogleAccessToken();
  const res = await fetchWithTimeout(
    url,
    {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    },
    { label: "Calendar" },
  );
  if (!res.ok) {
    throw statusError(`Calendar API failed (${res.status}): ${await res.text()}`, res.status);
  }
  return res.json();
}

// Only GETs are retried; a retried write after an ambiguous timeout could
// duplicate it.
function authedFetch(url, options = {}) {
  const isRead = (options.method ?? "GET") === "GET";
  return isRead ? retryRead(() => authedFetchOnce(url, options)) : authedFetchOnce(url, options);
}

// Google's events.list requires timeMin/timeMax as RFC3339 WITH an offset;
// its timeZone parameter only shapes the response. Since 6ce4267 the model
// sends local wall-clock times ("2026-10-19T00:00:00"), which Google rejects
// with 400 Bad Request (every calendar lookup failed from 2026-10-18). Gives
// such a time the offset its zone has at that moment (DST-aware). Anything
// that already carries an offset, or doesn't parse, passes through as-is.
function zoneOffsetMinutes(instantMs, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - instantMs) / 60000);
}

export function withZoneOffset(localTime, zone) {
  if (typeof localTime !== "string" || /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(localTime)) return localTime;
  const wallMs = Date.parse(`${localTime}Z`);
  if (!Number.isFinite(wallMs)) return localTime;
  // Two passes settle the offset across a DST change.
  let offset = zoneOffsetMinutes(wallMs, zone);
  offset = zoneOffsetMinutes(wallMs - offset * 60000, zone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${localTime}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export async function calendarListEvents({ time_min, time_max, maxResults, timeZone }, config = readConfig()) {
  const limit = normalizeEventLimit(maxResults);
  const zone = resolveCalendarTimeZone(timeZone, config);
  const params = new URLSearchParams({
    timeMin: withZoneOffset(time_min, zone),
    timeMax: withZoneOffset(time_max, zone),
    timeZone: zone,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(limit),
  });
  const data = await authedFetch(`${CALENDAR_API}/events?${params}`);
  const items = data.items ?? [];
  const events = items.slice(0, limit).map((e) => ({
    id: e.id,
    summary: e.summary ?? "",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    description: e.description ?? "",
  }));
  return { events, truncated: items.length >= limit };
}

export async function calendarCreateEvent({ summary, start, end, description, timeZone }, config = readConfig()) {
  const zone = resolveCalendarTimeZone(timeZone, config);
  const data = await authedFetch(`${CALENDAR_API}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: start, timeZone: zone },
      end: { dateTime: end, timeZone: zone },
    }),
  });
  return { id: data.id, htmlLink: data.htmlLink };
}
