import { test } from "node:test";
import assert from "node:assert/strict";
import { capRejection, getMaxConnections } from "../../src/connectionCap.js";

test("malformed max_connections falls back to the default", () => {
  for (const bad of [0, -1, 1.5, "4", null, NaN, Infinity, [], {}]) {
    assert.equal(getMaxConnections({ max_connections: bad }), 4, String(bad));
  }
  assert.equal(getMaxConnections(null), 4);
});

test("over-cap counts still reject", () => {
  const r = capRejection(9, 4);
  assert.equal(r.reason, "at connection cap (9/4)");
  assert.match(r.response, /503/);
});
