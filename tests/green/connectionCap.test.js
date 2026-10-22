import { test } from "node:test";
import assert from "node:assert/strict";
import { capRejection, getMaxConnections, DEFAULT_MAX_CONNECTIONS } from "../../src/connectionCap.js";

test("default cap is 4 and config value overrides it", () => {
  assert.equal(DEFAULT_MAX_CONNECTIONS, 4);
  assert.equal(getMaxConnections({}), 4);
  assert.equal(getMaxConnections({ max_connections: 6 }), 6);
  assert.equal(typeof getMaxConnections(), "number");
});

test("under cap is accepted; at cap gets a 503 with reason body", () => {
  assert.equal(capRejection(3, 4), null);
  const r = capRejection(4, 4);
  assert.equal(r.reason, "at connection cap (4/4)");
  assert.match(r.response, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.ok(r.response.endsWith("\r\n\r\nat connection cap (4/4)"));
  assert.match(r.response, /Content-Length: 23\r\n/);
});
