// Gmail: read-only (search, read) plus exactly one write action, marking a
// message read. No send, no delete, no other label changes — see
// gmailMarkRead below for why the OAuth grant is broader than that.

import { getGoogleAccessToken } from "./googleAuth.js";
import { fetchWithTimeout, retryRead, statusError } from "./http.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function authedFetchOnce(url, options) {
  const token = await getGoogleAccessToken();
  const res = await fetchWithTimeout(
    url,
    {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    },
    { label: "Gmail" },
  );
  if (!res.ok) {
    throw statusError(`Gmail API failed (${res.status}): ${await res.text()}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Only GETs are retried; a retried write after an ambiguous timeout could
// duplicate it.
function authedFetch(url, options = {}) {
  const isRead = (options.method ?? "GET") === "GET";
  return isRead ? retryRead(() => authedFetchOnce(url, options)) : authedFetchOnce(url, options);
}

function headerValue(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// Messages are an arbitrarily nested MIME tree (multipart/alternative,
// multipart/mixed with attachments, etc.) — walk it depth-first for the
// first part whose mimeType matches the predicate and that actually has
// body data.
function findPart(payload, predicate) {
  if (!payload) return null;
  if (predicate(payload) && payload.body?.data) return payload;
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findPart(part, predicate);
      if (found) return found;
    }
  }
  return null;
}

function decodeBase64Url(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

const HTML_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// Good enough to be readable in a conversational reply, not a faithful
// render — strip tags/scripts/styles, decode the entities real mail
// actually uses, and collapse the whitespace tags leave behind.
function htmlToText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (match, entity) => {
      if (entity[0] === "#") {
        const code =
          entity[1]?.toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      const key = entity.toLowerCase();
      return key in HTML_ENTITIES ? HTML_ENTITIES[key] : match;
    })
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBody(payload) {
  if (!payload) return "";
  const plain = findPart(payload, (p) => p.mimeType === "text/plain");
  if (plain) return decodeBase64Url(plain.body.data);
  const html = findPart(payload, (p) => p.mimeType === "text/html");
  if (html) return htmlToText(decodeBase64Url(html.body.data));
  const any = findPart(payload, () => true);
  if (any) return decodeBase64Url(any.body.data);
  return "";
}

export async function gmailSearch({ query }) {
  const listData = await authedFetch(
    `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=10`,
  );
  const messages = listData?.messages ?? [];
  const resultSizeEstimate = listData?.resultSizeEstimate ?? messages.length;
  // A single message detail fetch can fail on its own (deleted between the
  // list and detail call, a transient API hiccup) without the others being
  // bad too. Promise.all would sink the whole search over one bad message;
  // allSettled lets the rest through and we just drop the failures.
  const settled = await Promise.allSettled(
    messages.map(async (m) => {
      const msg = await authedFetch(
        `${GMAIL_API}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      );
      return {
        id: msg.id,
        snippet: msg.snippet ?? "",
        subject: headerValue(msg.payload?.headers, "Subject"),
        from: headerValue(msg.payload?.headers, "From"),
        date: headerValue(msg.payload?.headers, "Date"),
      };
    }),
  );
  const results = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  return { results, resultSizeEstimate, truncated: resultSizeEstimate > results.length };
}

export async function gmailReadMessage({ message_id }) {
  const msg = await authedFetch(`${GMAIL_API}/messages/${message_id}?format=full`);
  return {
    id: msg.id,
    subject: headerValue(msg.payload?.headers, "Subject"),
    from: headerValue(msg.payload?.headers, "From"),
    date: headerValue(msg.payload?.headers, "Date"),
    body: extractBody(msg.payload),
  };
}

// The narrowest OAuth scope Gmail's API offers for marking a message read is
// gmail.modify — there is no dedicated "mark as read" scope, so the OAuth
// grant is broader than what this code actually does. What stays narrow is
// this function's *behavior*: it must never call anything with the
// gmail.modify grant except removing the UNREAD label from exactly the one
// message ID it was given. Do not extend this function to touch other
// labels, other messages, or add/remove anything besides UNREAD.
export async function gmailMarkRead({ message_id }) {
  await authedFetch(`${GMAIL_API}/messages/${message_id}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
  return { ok: true, message_id };
}
