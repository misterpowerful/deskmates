// Covers the success path of useAutoConversation.js's start() — the mic
// permission grant resolves, conversation mode actually goes "listening",
// and no mic-start error is left behind. See the adversarial counterpart
// for the failure paths (getUserMedia rejected / MediaRecorder unsupported)
// this composable now also surfaces, instead of leaving pipelineState.state
// stuck on "idle" with no visible reason.
import test from "node:test";
import assert from "node:assert/strict";

// webapp/src/composables/session.js (imported transitively by
// useAutoConversation.js) reads localStorage at module scope; Node has no
// such global, so stub it before the dynamic import below pulls it in.
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
    return { fftSize: 1024, getFloatTimeDomainData() {} };
  }
}

global.window = { AudioContext: MockAudioContext };
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};

// Node's own `navigator` global has only a getter (no setter), so a plain
// `global.navigator = ...` throws under ESM's implicit strict mode.
function mockNavigator(getUserMedia) {
  Object.defineProperty(global, "navigator", {
    value: { mediaDevices: { getUserMedia } },
    configurable: true,
  });
}

const { start, stop, autoConversation, micStartError } = await import(
  "../../webapp/src/composables/useAutoConversation.js"
);
const { pipelineState } = await import("../../webapp/src/composables/pipelineState.js");

test.afterEach(() => {
  stop();
});

test("start() with a granted mic goes listening and leaves no mic-start error behind", async () => {
  mockNavigator(async () => ({ getTracks: () => [] }));

  await start();

  assert.equal(autoConversation.active, true);
  assert.equal(pipelineState.state, "listening");
  assert.equal(micStartError.message, null);
});

test("a prior mic-start error clears as soon as a new start() attempt begins", async () => {
  micStartError.message = "No microphone found";
  mockNavigator(async () => ({ getTracks: () => [] }));

  await start();

  assert.equal(micStartError.message, null);
});
