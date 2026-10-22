import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clientIpFromRequest,
  isValidTimezone,
  resolveTimezone,
  formatTimeTag,
  withTimeTag,
  TIME_RULE,
  FALLBACK_TIMEZONE,
} from "../../src/clientTime.js";

const req = (remote, headers = {}) => ({ socket: { remoteAddress: remote }, headers });

test("direct public peer is used as-is; forwarded headers are ignored", () => {
  assert.equal(clientIpFromRequest(req("8.8.8.8", { "x-real-ip": "1.1.1.1" })), "8.8.8.8");
});

test("behind loopback nginx: X-Real-IP wins, else last X-Forwarded-For entry", () => {
  assert.equal(clientIpFromRequest(req("127.0.0.1", { "x-real-ip": "8.8.4.4" })), "8.8.4.4");
  assert.equal(clientIpFromRequest(req("::1", { "x-forwarded-for": "9.9.9.9, 8.8.8.8" })), "8.8.8.8");
  assert.equal(clientIpFromRequest(req("::ffff:127.0.0.1", { "x-real-ip": ["8.8.4.4"] })), "8.8.4.4");
  assert.equal(clientIpFromRequest(req("127.0.0.1", { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] })), "5.6.7.8");
});

test("loopback with no usable header falls back to the loopback peer", () => {
  assert.equal(clientIpFromRequest(req("127.0.0.1")), "127.0.0.1");
});

test("isValidTimezone accepts IANA names only", () => {
  assert.equal(isValidTimezone("America/Chicago"), true);
  assert.equal(isValidTimezone("Not/AZone"), false);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone(undefined), false);
});

test("resolveTimezone: override, then IP lookup, then default, then UTC", () => {
  const lookup = () => ({ timezone: "Europe/London" });
  assert.equal(resolveTimezone("8.8.8.8", { timezone_override: "Asia/Tokyo" }, lookup), "Asia/Tokyo");
  assert.equal(resolveTimezone("8.8.8.8", {}, lookup), "Europe/London");
  assert.equal(resolveTimezone("8.8.8.8", { default_timezone: "America/Chicago" }, () => null), "America/Chicago");
  assert.equal(resolveTimezone(null, {}), FALLBACK_TIMEZONE);
});

test("resolveTimezone works with the real offline database", () => {
  const tz = resolveTimezone("8.8.8.8", { default_timezone: "America/Chicago" });
  assert.equal(isValidTimezone(tz), true);
  assert.equal(resolveTimezone("10.0.0.1", { default_timezone: "America/Chicago" }), "America/Chicago");
});

test("formatTimeTag renders local date, time and zone abbreviation", () => {
  const now = new Date("2026-10-14T14:47:00Z");
  assert.equal(formatTimeTag("America/Chicago", now), "[TIME: Wednesday, October 14, 2026 at 9:47 AM CDT]");
  assert.match(formatTimeTag("UTC", now), /^\[TIME: Wednesday, October 14, 2026 at 2:47 PM UTC\]$/);
});

test("withTimeTag prefixes the turn using the socket's zone, else config default", () => {
  const now = new Date("2026-10-14T14:47:00Z");
  const withWs = withTimeTag("[MODE: friendly] hi", { timezone: "Europe/London" }, {}, now);
  assert.match(withWs, /^\[TIME: .*3:47 PM (GMT\+1|BST)\] \[MODE: friendly\] hi$/);
  const noWs = withTimeTag("hi", undefined, { default_timezone: "America/Chicago" }, now);
  assert.match(noWs, /9:47 AM CDT\] hi$/);
});

test("TIME_RULE tells the model not to recite the time unprompted", () => {
  assert.match(TIME_RULE, /never read it out unprompted/);
});
