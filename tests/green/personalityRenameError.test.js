// Covers session.js's fix for PersonalityNamesDrawer.vue's permanently-stuck
// "saving" spinner on a failed set_personality_display_name: a rejected
// rename comes back as a generic { type: "error", id, reason } frame (same
// shape as any other failed request), and session.js now tags the
// outstanding request with kind:"display_name" so that frame can be routed
// to onPersonalityRenameError's handler instead of only reaching the hidden
// Log panel. See the adversarial counterpart for the cases that must NOT
// trigger that handler (unrelated request kinds, unknown ids, stale ids).
import test from "node:test";
import assert from "node:assert/strict";

global.localStorage = {
  _store: new Map(),
  getItem(key) {
    return this._store.has(key) ? this._store.get(key) : null;
  },
  setItem(key, value) {
    this._store.set(key, String(value));
  },
};

global.location = { protocol: "http:", host: "test.invalid" };

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = {};
    MockWebSocket.instances.push(this);
  }
  addEventListener(type, cb) {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    // Real WebSocket.close() fires its own "close" event asynchronously;
    // session.js's close handler is what resets its module-level `ws` back
    // to null, so without this, connect() in the next test would see a
    // stale non-null `ws` and silently no-op.
    this.dispatch("close", { code, reason });
  }
  dispatch(type, ev = {}) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open", {});
  }
  message(obj) {
    this.dispatch("message", { data: JSON.stringify(obj) });
  }
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
MockWebSocket.instances = [];
global.WebSocket = MockWebSocket;

const { setToken, connect, disconnect, setPersonalityDisplayName, onPersonalityRenameError, session } = await import(
  "../../webapp/src/composables/session.js"
);

function latestSocket() {
  return MockWebSocket.instances.at(-1);
}

function idFromSentDisplayNameRequest(ws) {
  const raw = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "set_personality_display_name");
  return raw.id;
}

test.beforeEach(() => {
  MockWebSocket.instances.length = 0;
  setToken("test-token");
  connect();
  latestSocket().open();
});

test.afterEach(() => {
  disconnect();
});

test("a rejected rename calls onPersonalityRenameError with the slug and server reason", () => {
  let got = null;
  onPersonalityRenameError((name, reason) => {
    got = { name, reason };
  });

  setPersonalityDisplayName("chet", "");
  const ws = latestSocket();
  const id = idFromSentDisplayNameRequest(ws);

  ws.message({ type: "error", id, reason: "set_personality_display_name requires name and a non-empty display_name" });

  assert.deepEqual(got, {
    name: "chet",
    reason: "set_personality_display_name requires name and a non-empty display_name",
  });
});

test("a successful rename updates session.displayNames and does not call the rename-error handler", () => {
  let called = false;
  onPersonalityRenameError(() => {
    called = true;
  });

  setPersonalityDisplayName("chet", "Chester");
  const ws = latestSocket();
  const id = idFromSentDisplayNameRequest(ws);

  ws.message({ type: "personality_display_name_result", id, name: "chet", display_name: "Chester" });

  assert.equal(session.displayNames.chet, "Chester");
  assert.equal(called, false);
});
