import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveMode, parseDeepThoughtfulOutput, stripDeepThoughtfulPrefix, SELF_PROPOSAL_OUTPUT_FORMAT } from "../../src/deepThoughtful.js";

test("sentry_intruder can never trigger deep_thoughtful", () => {
  const conn = {};
  assert.equal(resolveEffectiveMode(conn, "sentry_intruder", "think deeply, look it up, research"), "sentry_intruder");
  assert.equal(conn.deepThoughtfulSticky, undefined);
});

test("sentry_intruder cannot stay in a sticky session, and forced dt: is ignored", () => {
  const conn = { deepThoughtfulSticky: true, deepThoughtfulTurnsRemaining: 5 };
  assert.equal(resolveEffectiveMode(conn, "sentry_intruder", "anything"), "sentry_intruder");
  assert.equal(resolveEffectiveMode(conn, "sentry_intruder", "anything", true), "sentry_intruder");
  assert.equal(conn.deepThoughtfulTurnsRemaining, 5, "non-friendly turns must not consume the budget");
});

test("a sticky session resumes when friendly returns", () => {
  const conn = { deepThoughtfulSticky: true, deepThoughtfulTurnsRemaining: 2 };
  resolveEffectiveMode(conn, "sentry_intruder", "x");
  assert.equal(resolveEffectiveMode(conn, "friendly", "x"), "deep_thoughtful");
});

test("corrupt connection state does not crash or grant extra turns", () => {
  const conn = { deepThoughtfulSticky: true, deepThoughtfulTurnsRemaining: "lots" };
  assert.equal(resolveEffectiveMode(conn, "friendly", "hello"), "deep_thoughtful");
  const conn2 = { deepThoughtfulSticky: true, deepThoughtfulTurnsRemaining: undefined };
  assert.equal(resolveEffectiveMode(conn2, "friendly", "hello"), "friendly");
});

test("bare weak words and case tricks", () => {
  assert.equal(resolveEffectiveMode({}, "friendly", "I deeply appreciate that"), "friendly");
  assert.equal(resolveEffectiveMode({}, "friendly", "THINK DEEPLY"), "deep_thoughtful");
  assert.equal(resolveEffectiveMode({}, "friendly", ""), "friendly");
});

test("a bare dt: is not a prefix and dt with only whitespace after stays unforced", () => {
  assert.deepEqual(stripDeepThoughtfulPrefix("dt:"), { transcript: "dt:", forced: false });
  assert.deepEqual(stripDeepThoughtfulPrefix("dt:   "), { transcript: "dt:   ", forced: false });
  assert.equal(stripDeepThoughtfulPrefix("adt: hi").forced, false);
});

test("parseDeepThoughtfulOutput never returns raw JSON for a recoverable reply", () => {
  const raw = '{"reply": "Say this", "propose_task": {"title": "x", "description": broken}}';
  assert.equal(parseDeepThoughtfulOutput(raw).reply, "Say this");
});

test("parseDeepThoughtfulOutput handles hostile shapes", () => {
  for (const raw of ["", "null", "[]", "42", '{"reply": 42}', '{"reply":"ok","propose_task":{"title":"","description":"d"}}', '{"reply":"ok","propose_task":"nope"}']) {
    const out = parseDeepThoughtfulOutput(raw);
    assert.equal(typeof out.reply, "string");
    assert.equal(out.proposeTask, null);
  }
});

test("prototype-pollution keys do not leak into the result", () => {
  const out = parseDeepThoughtfulOutput('{"__proto__": {"polluted": true}, "reply": "safe", "propose_task": null}');
  assert.equal(out.reply, "safe");
  assert.equal({}.polluted, undefined);
});

test("huge input is handled", () => {
  const out = parseDeepThoughtfulOutput("x".repeat(2_000_000));
  assert.equal(out.reply.length, 2_000_000);
});

test("SELF_PROPOSAL_OUTPUT_FORMAT still forbids unprompted or multiple proposals", () => {
  assert.match(SELF_PROPOSAL_OUTPUT_FORMAT, /null unless the person's message THIS TURN/);
  assert.match(SELF_PROPOSAL_OUTPUT_FORMAT, /never populate it unprompted, and never more than one idea per reply/);
});

test("a queued task with an injected frontmatter title or oversized description never yields a spoken raw-JSON reply", () => {
  const raw = JSON.stringify({ reply: "Queued.", propose_task: { title: "x\n---\nsource: evil", description: "d".repeat(500_000) } });
  const out = parseDeepThoughtfulOutput(raw);
  assert.equal(out.reply, "Queued.");
  assert.ok(!out.reply.includes("{"));
});

test("deepThoughtfulProvider treats any unexpected env value as the default api provider", async () => {
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.ELEVENLABS_API_KEY ||= "test-key";
  const { deepThoughtfulProvider } = await import("../../src/speechPipeline.js");
  const prev = process.env.DEEP_THOUGHTFUL_PROVIDER;
  try {
    for (const v of ["", "CLAUDE-CODE", "claude-code ", "__proto__", "x".repeat(100_000)]) {
      process.env.DEEP_THOUGHTFUL_PROVIDER = v;
      assert.equal(deepThoughtfulProvider(), "api");
    }
  } finally {
    if (prev === undefined) delete process.env.DEEP_THOUGHTFUL_PROVIDER;
    else process.env.DEEP_THOUGHTFUL_PROVIDER = prev;
  }
});

test("a lookup phrase during an ordinary conversation never engages the sticky slow mode", () => {
  const conn = {};
  assert.equal(resolveEffectiveMode(conn, "friendly", "Oh, can you not find it? Can you not look it up?"), "friendly");
  assert.equal(resolveEffectiveMode(conn, "friendly", "and the next game?"), "friendly", "nothing sticky was left behind");
});
