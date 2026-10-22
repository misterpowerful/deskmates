import test from "node:test";
import assert from "node:assert/strict";
import { withZoneOffset } from "../../src/tools/calendar.js";

test("times that already carry an offset or Z are never double-offset", () => {
  assert.equal(withZoneOffset("2026-10-19T00:00:00Z", "America/Chicago"), "2026-10-19T00:00:00Z");
  assert.equal(withZoneOffset("2026-10-19T00:00:00-05:00", "America/Chicago"), "2026-10-19T00:00:00-05:00");
  assert.equal(withZoneOffset("2026-10-19T00:00:00+0100", "America/Chicago"), "2026-10-19T00:00:00+0100");
});

test("garbage and non-strings pass through untouched rather than throwing", () => {
  assert.equal(withZoneOffset("tomorrow-ish", "America/Chicago"), "tomorrow-ish");
  assert.equal(withZoneOffset("", "America/Chicago"), "");
  assert.equal(withZoneOffset(undefined, "America/Chicago"), undefined);
  assert.equal(withZoneOffset(12345, "America/Chicago"), 12345);
});

test("the offset follows daylight saving across the November change", () => {
  // US DST ends 2026-11-01 at 02:00 local.
  assert.equal(withZoneOffset("2026-10-31T23:00:00", "America/Chicago"), "2026-10-31T23:00:00-05:00");
  assert.equal(withZoneOffset("2026-11-02T00:00:00", "America/Chicago"), "2026-11-02T00:00:00-06:00");
});
