import test from "node:test";
import assert from "node:assert/strict";
import { extractBody } from "../../src/tools/gmail.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("extractBody returns text/plain body unchanged", () => {
  const payload = {
    mimeType: "text/plain",
    body: { data: b64("Hello, this is plain text.") },
  };
  assert.equal(extractBody(payload), "Hello, this is plain text.");
});

test("extractBody falls back to text/html and converts it to readable text", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: b64("<html><body><p>Hello <b>world</b></p><p>Second line</p></body></html>") },
  };
  const body = extractBody(payload);
  assert.equal(body, "Hello world\nSecond line");
});

test("extractBody decodes common HTML entities when falling back to html", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: b64("<p>Tom &amp; Jerry say &quot;hi&quot; &#39;quote&#39;&nbsp;here</p>") },
  };
  assert.equal(extractBody(payload), 'Tom & Jerry say "hi" \'quote\' here');
});

test("extractBody prefers text/plain over text/html in multipart/alternative", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64("Plain wins") } },
      { mimeType: "text/html", body: { data: b64("<p>HTML loses</p>") } },
    ],
  };
  assert.equal(extractBody(payload), "Plain wins");
});

test("extractBody decodes numeric HTML entities (decimal and hex)", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: b64("<p>&#65;&#x42;&#67;</p>") },
  };
  assert.equal(extractBody(payload), "ABC");
});

test("extractBody finds html nested inside multipart/mixed with attachments", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/html", body: { data: b64("<p>Nested html body</p>") } }],
      },
      { mimeType: "application/pdf", body: { data: b64("not text"), attachmentId: "a1" } },
    ],
  };
  assert.equal(extractBody(payload), "Nested html body");
});
