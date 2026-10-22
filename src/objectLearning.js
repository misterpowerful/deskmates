// Interactive unknown-object learning loop.
//
// During an explicitly assigned exploration/learning task (never
// spontaneous — see runObjectLearningStep's `assignedTask` gate, the same
// structural-fact pattern TOOL_ENABLED_MODES and self_improve_personalities
// use elsewhere in this codebase), the bot can:
//   1. capture a camera snapshot of whatever it's looking at,
//   2. check it against objects already learned for the active personality,
//   3. if nothing matches closely enough, ask the owner what it is over the
//      live conversation pipeline, and
//   4. store the label plus enough identifying data to recognize the same
//      object next time.
//
// Storage is per-personality (personalities/<name>/objects.json, plus a
// personalities/<name>/learned-objects/ folder of saved reference images),
// mirroring memory.json's pattern but kept in its own file/schema since
// this is visual/object data, not a freeform fact — see appendMemoryFact in
// longTermMemory.js for the sibling this deliberately parallels.
//
// No camera/image pipeline is wired into the live WebSocket protocol on
// every deployment yet (messageValidation.js's KNOWN_MESSAGE_TYPES has no
// image-frame message type). captureSnapshot always degrades to
// { available: false } unless the caller supplies a working `provider`, so
// every function in this module is safe to call — and everything above it
// safe to leave wired up — on a deployment with no camera hooked up at all.
//
// v1 similarity is deliberately coarse (a simplified average-hash over raw
// bytes, no image-decode dependency) rather than a real embedding model —
// good enough to tell "basically the same object as before" from
// "something new" without adding a new heavy dependency for this pass.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "./logger.js";

const ROOT = process.cwd();
const LEARNED_OBJECTS_DIRNAME = "learned-objects";

const HASH_BITS = 64;
// Below this a chunked average is mostly padding, not a real fingerprint.
const MIN_IMAGE_BYTES = 16;
// Guards disk usage against a hostile/malfunctioning capture, same spirit
// as MAX_WS_PAYLOAD_BYTES in messageValidation.js.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Out of HASH_BITS bits; a coarse "close enough" match threshold for v1.
const MATCH_HAMMING_THRESHOLD = 10;
const MAX_LABEL_LENGTH = 80;
// A reply arriving this long after the question was asked is ordinary chat
// resuming, not an answer to it.
const PENDING_QUESTION_TTL_MS = 5 * 60 * 1000;

function objectsPath(personalityName) {
  return path.join(ROOT, "personalities", String(personalityName), "objects.json");
}

function learnedObjectsDir(personalityName) {
  return path.join(ROOT, "personalities", String(personalityName), LEARNED_OBJECTS_DIRNAME);
}

// ---- snapshot capture hook ---------------------------------------------

// Pluggable camera-snapshot hook (periodic snapshots, not continuous
// video — one call here is one still image). `provider` is an async
// () => { buffer, mimeType } function a live deployment can supply once its
// camera pipeline exists, or a test double supplies for these tests. With
// no provider (the default on any deployment without that hardware/
// protocol yet) this always reports unavailable rather than throwing.
export async function captureSnapshot({ provider } = {}) {
  if (typeof provider !== "function") {
    return { available: false, reason: "no-camera-pipeline" };
  }
  let image;
  try {
    image = await provider();
  } catch (err) {
    log("object learning: snapshot capture failed", { error: err?.message ?? String(err) });
    return { available: false, reason: "capture-error" };
  }
  const buffer = image?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) {
    return { available: false, reason: "empty-capture" };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { available: false, reason: "capture-too-large" };
  }
  return { available: true, buffer, mimeType: image?.mimeType ?? "image/jpeg" };
}

// ---- coarse image hashing / matching -----------------------------------

// Splits the raw byte buffer into HASH_BITS equal-ish chunks, averages
// each, and sets a bit for whether that chunk's average is at or above the
// whole image's average — a simplified average-hash. Works directly on raw
// bytes (no JPEG/PNG decode dependency), deliberately coarse per the task,
// and good enough for "same object again" vs. "something new". Returns
// null for anything too small to fingerprint meaningfully, rather than
// silently hashing padding.
export function computeImageHash(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) return null;

  const chunkSize = buffer.length / HASH_BITS;
  const chunkAverages = new Array(HASH_BITS);
  let total = 0;
  for (let i = 0; i < HASH_BITS; i++) {
    const start = Math.floor(i * chunkSize);
    const end = i === HASH_BITS - 1 ? buffer.length : Math.floor((i + 1) * chunkSize);
    let sum = 0;
    for (let j = start; j < end; j++) sum += buffer[j];
    const count = Math.max(1, end - start);
    const avg = sum / count;
    chunkAverages[i] = avg;
    total += avg;
  }
  const overallAvg = total / HASH_BITS;

  let hash = "";
  for (const avg of chunkAverages) hash += avg >= overallAvg ? "1" : "0";
  return hash;
}

// Bit-distance between two hashes; Infinity for anything that can't be
// compared (missing/malformed/mismatched-length input) so a caller's
// "closest match" scan never mistakes an invalid comparison for a good one.
export function hammingDistance(hashA, hashB) {
  if (
    typeof hashA !== "string" ||
    typeof hashB !== "string" ||
    hashA.length === 0 ||
    hashA.length !== hashB.length
  ) {
    return Infinity;
  }
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) distance++;
  }
  return distance;
}

// ---- storage: personalities/<name>/objects.json ------------------------

// Read-only accessor: a missing or unparseable file quietly reads as "no
// objects learned yet" — same as getLongTermMemoryBlock in
// longTermMemory.js, which never backs up on a bad read either. Backing up
// a corrupt file is only the write path's job (see readObjectsFileForWrite
// below), so a read-only lookup like recognizeObject can't itself produce
// backup files.
function readObjectsFileSilent(personalityName) {
  try {
    const parsed = JSON.parse(fs.readFileSync(objectsPath(personalityName), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Same corrupt-file handling as appendMemoryFact in longTermMemory.js: a
// present-but-unparseable (or non-array) file is copied to a
// objects.json.corrupt-<timestamp> backup and logged, never silently
// dropped, before continuing with an empty list that the caller then
// overwrites with fresh data.
function readObjectsFileForWrite(personalityName) {
  const filePath = objectsPath(personalityName);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // falls through to the backup below
  }

  const backup = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(filePath, backup);
  log("object learning: objects.json is unparseable, backed up before continuing", {
    personalityName,
    backup,
  });
  return [];
}

// Writes go through tmp + rename, same as memory.json, so a crash mid-write
// can't truncate the file.
function writeObjectsFile(personalityName, objects) {
  const filePath = objectsPath(personalityName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(objects, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

function sanitizeLabel(label) {
  if (typeof label !== "string") return null;
  const cleaned = label
    .replace(/[ -]/g, "") // strip control chars/NUL
    .trim()
    .replace(/\s+/g, " ");
  // A label needs at least one letter/digit — "!!!" or "..." isn't an
  // object name, it's a garbled/hostile reply that failed to reduce to one.
  if (!cleaned || !/[a-z0-9]/i.test(cleaned)) return null;
  return cleaned.length > MAX_LABEL_LENGTH ? cleaned.slice(0, MAX_LABEL_LENGTH).trim() : cleaned;
}

function slugifyLabel(label) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "object";
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

// Saves the raw snapshot bytes next to objects.json so a future deployment
// with a real embedding model can re-derive better features from the same
// image without re-asking the owner. Returns a path relative to the
// personality's own folder (what's written into objects.json), not an
// absolute one.
function saveReferenceImage(personalityName, buffer, mimeType, label) {
  const dir = learnedObjectsDir(personalityName);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${slugifyLabel(label)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extensionForMimeType(mimeType)}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return path.join(LEARNED_OBJECTS_DIRNAME, filename);
}

// Shared append primitive: read-modify-write personalities/<name>/
// objects.json, mirroring appendMemoryFact's pattern in longTermMemory.js.
// Append-only by design (v1 doesn't dedupe by label — a second photo of the
// same kind of object under a different label, or from a different angle,
// only improves future matching), unlike memory.json's exact-duplicate
// skip.
export function learnObject(personalityName, label, buffer, { mimeType = "image/jpeg" } = {}) {
  const cleanLabel = sanitizeLabel(label);
  if (!cleanLabel) return { saved: false, reason: "empty-label" };

  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) {
    return { saved: false, reason: "invalid-image" };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { saved: false, reason: "image-too-large" };
  }

  const hash = computeImageHash(buffer);
  if (!hash) return { saved: false, reason: "invalid-image" };

  const imagePath = saveReferenceImage(personalityName, buffer, mimeType, cleanLabel);
  const entry = {
    label: cleanLabel,
    hash,
    imagePath,
    mimeType,
    learnedAt: new Date().toISOString(),
  };

  const objects = readObjectsFileForWrite(personalityName);
  objects.push(entry);
  writeObjectsFile(personalityName, objects);
  log("object learning: object saved", { personalityName, label: cleanLabel });
  return { saved: true, entry };
}

// Compares a freshly captured snapshot's hash against everything already
// learned for this personality and returns the closest match within
// MATCH_HAMMING_THRESHOLD bits, or null if nothing is close enough — the
// "recognize on future encounters" half of the loop. A plain nearest-match
// scan: v1 doesn't need an index, objects.json is append-only and expected
// to stay small.
export function recognizeObject(personalityName, buffer) {
  const hash = computeImageHash(buffer);
  if (!hash) return null;

  const objects = readObjectsFileSilent(personalityName);
  let best = null;
  let bestDistance = Infinity;
  for (const entry of objects) {
    if (!entry || typeof entry.hash !== "string" || typeof entry.label !== "string") continue;
    const distance = hammingDistance(hash, entry.hash);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  if (!best || bestDistance > MATCH_HAMMING_THRESHOLD) return null;
  return { label: best.label, distance: bestDistance, imagePath: best.imagePath };
}

// ---- ask-and-store conversational flow ---------------------------------

// `assignedTask` is a structural gate — the same pattern TOOL_ENABLED_MODES
// and isSelfImproveApproved use elsewhere in this codebase: this whole loop
// only runs when the caller can point to an explicitly assigned
// exploration/learning task ({ assigned: true }), never merely because a
// conversation is happening, per the "initiative only inside an assigned
// task" rule. Wiring up *how* a task gets assigned during a live
// conversation is a WebSocket-protocol change outside this module's scope
// (see the module comment) — every caller must already have that decided.
export async function runObjectLearningStep(connection, personalityName, assignedTask, { provider } = {}) {
  if (!assignedTask || assignedTask.assigned !== true) {
    return { status: "not-assigned" };
  }

  const snapshot = await captureSnapshot({ provider });
  if (!snapshot.available) {
    return { status: "no-camera", reason: snapshot.reason };
  }

  const match = recognizeObject(personalityName, snapshot.buffer);
  if (match) {
    return { status: "recognized", label: match.label, distance: match.distance };
  }

  if (connection) {
    connection.pendingObjectLearning = {
      buffer: snapshot.buffer,
      mimeType: snapshot.mimeType,
      askedAt: Date.now(),
    };
  }
  return { status: "unknown", question: "I don't recognize this one — what is it?" };
}

// Prefixes stripped from a spoken reply before it becomes a stored label —
// "it's a stapler" / "that's called a mug" / "an apple" all reduce to just
// the object name. Applied repeatedly (a reply can combine both forms,
// e.g. "it's an apple") until nothing more matches.
const LABEL_PREFIXES = [/^(it'?s|that'?s|this is)\s+(called\s+)?(an?\s+)?/i, /^(an?\s+)/i];

function stripLabelPrefixes(text) {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LABEL_PREFIXES) {
      const next = out.replace(re, "");
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out;
}

// Reduces a spoken reply to a usable label, or null if there isn't one
// (empty/whitespace-only, or nothing left after stripping punctuation and
// prefixes — e.g. a reply of just "!!!"). Exported separately from
// resolvePendingObjectLabel so a certain-phrase "that's a stapler" said
// without a pending question could also be wired in later, the same way
// CERTAIN_TRIGGER_PHRASES is separate from condenseAndStore in
// longTermMemory.js.
export function extractLabelFromReply(transcript) {
  const text = (transcript ?? "").trim();
  if (!text) return null;
  const stripped = stripLabelPrefixes(text).replace(/[.!?]+$/, "").trim();
  return sanitizeLabel(stripped);
}

// Resolves a pending object-learning question (set by runObjectLearningStep)
// against this turn's transcript. Returns { resolved: false } for anything
// that isn't actually answering a pending question — none outstanding, one
// that's expired (PENDING_QUESTION_TTL_MS — a reply this long after asking
// is ordinary chat resuming, not a label), or a reply that doesn't reduce
// to a usable label — so a late or garbled utterance never gets mistaken
// for teaching the bot a new object. Always clears the pending state before
// returning, successful or not, so a bad reply can't be "answered" twice.
export function resolvePendingObjectLabel(connection, personalityName, transcript) {
  const pending = connection?.pendingObjectLearning;
  if (!pending) return { resolved: false, reason: "no-pending-question" };
  delete connection.pendingObjectLearning;

  if (Date.now() - pending.askedAt > PENDING_QUESTION_TTL_MS) {
    return { resolved: false, reason: "expired" };
  }

  const label = extractLabelFromReply(transcript);
  if (!label) return { resolved: false, reason: "no-usable-label" };

  const result = learnObject(personalityName, label, pending.buffer, { mimeType: pending.mimeType });
  if (!result.saved) return { resolved: false, reason: result.reason };
  return { resolved: true, label: result.entry.label };
}
