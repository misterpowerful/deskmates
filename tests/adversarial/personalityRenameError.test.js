// Adversarial counterpart to tests/green/personalityRenameError.test.js:
// the generic "error" frame's id is attacker/server-controlled from the
// client's point of view (could be stale, forged, or belong to an unrelated
// in-flight request), so onPersonalityRenameError must only fire for an id
// session.js itself tagged kind:"display_name" — never for an unrelated
// request, an unknown id, a frame whose request already resolved, or a
// malformed frame — and must never throw.
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

const {
  setToken,
  connect,
  disconnect,
  setPersonalityDisplayName,
  sendGetCanned,
  onPersonalityRenameError,
} = await import("../../webapp/src/composables/session.js");

function latestSocket() {
  return MockWebSocket.instances.at(-1);
}

function idFromSentMessage(ws, type) {
  return ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === type).id;
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

test("an error for an unrelated outstanding request (get_canned) does not call the rename-error handler", () => {
  let called = false;
  onPersonalityRenameError(() => {
    called = true;
  });

  const id = sendGetCanned("greeting");
  const ws = latestSocket();
  assert.equal(idFromSentMessage(ws, "get_canned"), id);

  assert.doesNotThrow(() => ws.message({ type: "error", id, reason: "boom" }));
  assert.equal(called, false);
});

test("an error for an id the client never issued does not call the handler and does not throw", () => {
  let called = false;
  onPersonalityRenameError(() => {
    called = true;
  });

  const ws = latestSocket();
  assert.doesNotThrow(() => ws.message({ type: "error", id: "forged-id-12345", reason: "whatever" }));
  assert.equal(called, false);
});

test("a duplicate/late error for an already-resolved rename does not re-fire the handler", () => {
  let callCount = 0;
  onPersonalityRenameError(() => {
    callCount += 1;
  });

  setPersonalityDisplayName("gatsby-sardonic", "Gatsby");
  const ws = latestSocket();
  const id = idFromSentMessage(ws, "set_personality_display_name");

  ws.message({ type: "personality_display_name_result", id, name: "gatsby-sardonic", display_name: "Gatsby" });
  // Same id resolves again (e.g. a duplicated/replayed frame) — the
  // outstanding-request entry was already deleted on success, so this must
  // be a no-op rather than a stale "rename failed" surfaced after the fact.
  assert.doesNotThrow(() => ws.message({ type: "error", id, reason: "late failure" }));
  assert.equal(callCount, 0);
});

test("two concurrent renames: an error for one slug does not report the other", () => {
  const calls = [];
  onPersonalityRenameError((name, reason) => {
    calls.push({ name, reason });
  });

  setPersonalityDisplayName("chet", "Chester");
  const ws1 = latestSocket();
  const id1 = idFromSentMessage(ws1, "set_personality_display_name");

  setPersonalityDisplayName("gatsby-sardonic", "");
  const ws2 = latestSocket();
  const secondRequest = ws2.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "set_personality_display_name").at(-1);
  const id2 = secondRequest.id;

  assert.notEqual(id1, id2);

  ws2.message({ type: "error", id: id2, reason: "set_personality_display_name requires name and a non-empty display_name" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "gatsby-sardonic");

  // The still-outstanding chet rename must be unaffected by gatsby's failure.
  ws1.message({ type: "personality_display_name_result", id: id1, name: "chet", display_name: "Chester" });
  assert.equal(calls.length, 1);
});

test("a malformed error frame (missing reason) is forwarded without throwing", () => {
  let got = "unset";
  onPersonalityRenameError((name, reason) => {
    got = reason;
  });

  setPersonalityDisplayName("chet", "Chester");
  const ws = latestSocket();
  const id = idFromSentMessage(ws, "set_personality_display_name");

  assert.doesNotThrow(() => ws.message({ type: "error", id }));
  assert.equal(got, undefined);
});

test("no rename-error handler registered: a rejected rename does not throw", () => {
  onPersonalityRenameError(null);

  setPersonalityDisplayName("chet", "");
  const ws = latestSocket();
  const id = idFromSentMessage(ws, "set_personality_display_name");

  assert.doesNotThrow(() => ws.message({ type: "error", id, reason: "rejected" }));
});
