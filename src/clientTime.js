import geoip from "geoip-lite";

// Gatsby has no clock of his own. The bot never talks to Claude directly, so
// the server derives "what time is it for this person" per connection:
// client IP -> IANA timezone (offline GeoLite-derived database, no network
// hop) -> a one-line [TIME: ...] tag prepended to each turn.

export const FALLBACK_TIMEZONE = "UTC";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function cleanIp(value) {
  if (typeof value !== "string") return null;
  const ip = value.trim().replace(/^::ffff:/i, "");
  // Cheap sanity bound; geoip-lite rejects non-IPs itself.
  return ip && ip.length <= 45 ? ip : null;
}

// The server sits behind nginx on the same box, so the socket's peer is
// always loopback and the real client is only visible in a forwarded header.
// Forwarded headers are trusted ONLY when the direct peer is loopback —
// otherwise anyone could spoof their location. X-Real-IP wins; else the LAST
// X-Forwarded-For entry (the one our own proxy appended — earlier entries are
// client-controlled).
export function clientIpFromRequest(req) {
  const peer = cleanIp(req?.socket?.remoteAddress);
  if (peer && !LOOPBACK.has(peer)) return peer;
  const headers = req?.headers ?? {};
  const real = cleanIp(Array.isArray(headers["x-real-ip"]) ? headers["x-real-ip"][0] : headers["x-real-ip"]);
  if (real) return real;
  const xff = headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (typeof raw === "string") {
    const last = cleanIp(raw.split(",").pop());
    if (last) return last;
  }
  return peer;
}

export function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Order: config.timezone_override (hard pin) -> IP lookup -> config.
// default_timezone -> UTC. Carrier/hotspot IPs often geolocate to the wrong
// city or zone, hence the override and the default.
export function resolveTimezone(ip, config = {}, lookup = (addr) => geoip.lookup(addr)) {
  if (isValidTimezone(config?.timezone_override)) return config.timezone_override;
  let fromIp = null;
  if (ip) {
    try {
      fromIp = lookup(ip)?.timezone ?? null;
    } catch {
      fromIp = null;
    }
  }
  if (isValidTimezone(fromIp)) return fromIp;
  if (isValidTimezone(config?.default_timezone)) return config.default_timezone;
  return FALLBACK_TIMEZONE;
}

// "[TIME: Wednesday, October 14, 2026, 9:47 AM CDT]" — minute precision so the
// tag doesn't churn on every call. Never throws: a bad zone degrades to UTC.
export function formatTimeTag(timezone, now = new Date()) {
  const zone = isValidTimezone(timezone) ? timezone : FALLBACK_TIMEZONE;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  return `[TIME: ${text}]`;
}

// Static system-prompt line (kept constant so the personality prompt stays
// cacheable — the changing value lives in the user turn).
export const TIME_RULE =
  "TIME: each turn begins with a [TIME: ...] tag giving the person's current local date and time. Use it when it matters (what time/day it is, greetings, late-night or early-morning remarks); never read it out unprompted.";

// Prepends the time tag to a turn's user content. A socket with no resolved
// zone (e.g. a test harness) falls back through config's default_timezone.
export function withTimeTag(content, ws, config = {}, now = new Date()) {
  const zone = ws?.timezone ?? resolveTimezone(null, config);
  return `${formatTimeTag(zone, now)} ${content}`;
}
