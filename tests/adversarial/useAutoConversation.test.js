// A getUserMedia rejection or a thrown MediaRecorder construction both
// happen before any WebSocket turn exists (no speech_error/canned_error
// frame is ever involved), so turnErrorPolicy.js's transcript-row path
// never sees them. Before this fix, the only trace was a logErr() call into
// the hidden Log panel: autoConversation.active and pipelineState.state
// both silently stayed at their "never started" defaults, so a user tapping
// the mic saw nothing happen at all. Assert the failure now leaves a
// visible, non-empty micStartError.message instead.
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

class MockAudioContext {
  constructor() {
    this.state = "running";
  }
  async resume() {
    this.state = "running";
  }
  close() {
    this.state = "closed";
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    // getFloatTimeDomainData fills with a strong, constant signal so a
    // manually-fired vadTick callback always reads as "speech detected"
    // (rms >= VAD_THRESHOLD) — used to drive the MediaRecorder-throw test
    // down into beginUtteranceRecording() without that function being
    // exported itself.
    return { fftSize: 1024, getFloatTimeDomainData: (arr) => arr.fill(0.5) };
  }
}

let rafCallbacks = [];
global.window = { AudioContext: MockAudioContext };
global.requestAnimationFrame = (cb) => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
global.cancelAnimationFrame = () => {};

function mockNavigator(getUserMedia) {
  Object.defineProperty(global, "navigator", {
    value: { mediaDevices: { getUserMedia } },
    configurable: true,
  });
}

const { start, stop, autoConversation, micStartError, describeMicStartError } = await import(
  "../../webapp/src/composables/useAutoConversation.js"
);
const { pipelineState } = await import("../../webapp/src/composables/pipelineState.js");

test.beforeEach(() => {
  rafCallbacks = [];
});

test.afterEach(() => {
  stop();
});

test("a permission-denied getUserMedia rejection surfaces a plain-language blocked message, not silence", async () => {
  const err = new Error("Permission denied");
  err.name = "NotAllowedError";
  mockNavigator(async () => {
    throw err;
  });

  await start();

  assert.equal(autoConversation.active, false);
  assert.equal(pipelineState.state, "idle");
  assert.equal(typeof micStartError.message, "string");
  assert.ok(micStartError.message.length > 0);
  assert.match(micStartError.message, /blocked/i);
});

test("a getUserMedia rejection with no matching device surfaces a distinct 'no microphone' message", async () => {
  const err = new Error("Requested device not found");
  err.name = "NotFoundError";
  mockNavigator(async () => {
    throw err;
  });

  await start();

  assert.equal(autoConversation.active, false);
  assert.equal(pipelineState.state, "idle");
  assert.match(micStartError.message, /no microphone/i);
});

test("a getUserMedia rejection with no .name at all still fails safely with a non-empty message", async () => {
  mockNavigator(async () => {
    throw new Error("something went wrong");
  });

  await start();

  assert.equal(autoConversation.active, false);
  assert.equal(typeof micStartError.message, "string");
  assert.ok(micStartError.message.length > 0);
});

test("describeMicStartError never returns an empty string, even for a malformed/missing error", () => {
  for (const bad of [undefined, null, {}, "oops", 42, new Error()]) {
    const message = describeMicStartError(bad);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0);
  }
});

test("a thrown MediaRecorder construction mid-conversation surfaces a visible error and returns to idle, not a silent stop", async () => {
  mockNavigator(async () => ({ getTracks: () => [] }));
  global.MediaRecorder = class {
    constructor() {
      throw new Error("MediaRecorder unsupported");
    }
  };

  await start();
  assert.equal(pipelineState.state, "listening");
  assert.equal(micStartError.message, null);

  // The last requestAnimationFrame callback registered by start() is the
  // VAD loop's own vadTick (attachAudioLevel's level-meter tick registers
  // first) — fire it to simulate "speech detected", which drives
  // beginUtteranceRecording() -> `new MediaRecorder(vadStream)`.
  assert.ok(rafCallbacks.length > 0);
  rafCallbacks[rafCallbacks.length - 1]();

  assert.equal(autoConversation.active, false);
  assert.equal(pipelineState.state, "idle");
  assert.equal(typeof micStartError.message, "string");
  assert.ok(micStartError.message.length > 0);
});
