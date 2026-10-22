import test from "node:test";
import assert from "node:assert/strict";
import { extractBody } from "../../src/tools/gmail.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("extractBody fails safely on missing/empty payloads", () => {
  assert.equal(extractBody(null), "");
  assert.equal(extractBody(undefined), "");
  assert.equal(extractBody({}), "");
  assert.equal(extractBody({ mimeType: "text/plain" }), "");
  assert.equal(extractBody({ mimeType: "multipart/mixed", parts: [] }), "");
});

test("extractBody strips script/style content instead of leaking it as text", () => {
  const payload = {
    mimeType: "text/html",
    body: {
      data: b64(
        "<style>.x{color:red}</style><script>alert('x')</script><p>Visible text</p>",
      ),
    },
  };
  const body = extractBody(payload);
  assert.equal(body, "Visible text");
  assert.ok(!body.includes("color:red"));
  assert.ok(!body.includes("alert"));
});

test("extractBody tolerates malformed/unclosed html tags without throwing", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: b64("<p>Unclosed <b>tag <div>still readable") },
  };
  assert.doesNotThrow(() => extractBody(payload));
  const body = extractBody(payload);
  assert.ok(body.includes("Unclosed"));
  assert.ok(body.includes("still readable"));
});

test("extractBody collapses excessive whitespace and blank lines from hostile html", () => {
  const spam = "<p>line</p>".repeat(2000) + "<br><br><br><br>" + "&nbsp;".repeat(500);
  const payload = { mimeType: "text/html", body: { data: b64(spam) } };
  const body = extractBody(payload);
  assert.ok(!body.includes("\n\n\n"));
  assert.ok(!/ {2,}/.test(body));
});

test("extractBody ignores out-of-order/deeply nested html and still prefers plain text anywhere in the tree", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/related",
        parts: [{ mimeType: "text/html", body: { data: b64("<p>html found first</p>") } }],
      },
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "application/octet-stream", body: { data: b64("binary junk") } },
          { mimeType: "text/plain", body: { data: b64("plain found later") } },
        ],
      },
    ],
  };
  assert.equal(extractBody(payload), "plain found later");
});

test("extractBody falls back to raw data when neither text/plain nor text/html is present", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [{ mimeType: "application/octet-stream", body: { data: b64("raw fallback data") } }],
  };
  assert.equal(extractBody(payload), "raw fallback data");
});

test("extractBody leaves an unrecognized entity-like string untouched instead of corrupting it", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: b64("<p>Price &pound;5 &notarealentity; done</p>") },
  };
  const body = extractBody(payload);
  assert.ok(body.includes("&notarealentity;"));
});

test("extractBody does not throw on invalid base64 data", () => {
  const payload = { mimeType: "text/plain", body: { data: "not-valid-base64!!!" } };
  assert.doesNotThrow(() => extractBody(payload));
});

test("extractBody handles a part claiming text/plain with no body data by searching deeper", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain" },
      { mimeType: "text/html", body: { data: b64("<p>fallback html</p>") } },
    ],
  };
  assert.equal(extractBody(payload), "fallback html");
});
