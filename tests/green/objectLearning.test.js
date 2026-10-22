import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  captureSnapshot,
  computeImageHash,
  hammingDistance,
  learnObject,
  recognizeObject,
  runObjectLearningStep,
  extractLabelFromReply,
  resolvePendingObjectLabel,
} from "../../src/objectLearning.js";

const name = `_objlearn_green_${process.pid}`;
const dir = path.join(process.cwd(), "personalities", name);
const objectsFile = path.join(dir, "objects.json");
const imagesDir = path.join(dir, "learned-objects");
fs.mkdirSync(dir, { recursive: true });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Deterministic 256-byte fixture images: a rising gradient and its mirror,
// far enough apart in average-hash space to be reliably distinguishable.
function gradientBuffer(ascending) {
  return Buffer.from(Array.from({ length: 256 }, (_, i) => (ascending ? i : 255 - i)));
}
const staplerImage = gradientBuffer(true);
const mugImage = gradientBuffer(false);

function nearDuplicate(buffer) {
  const clone = Buffer.from(buffer);
  // Small perturbations, chosen away from the hash's chunk boundary so the
  // resulting image still reads as "the same object" to computeImageHash.
  clone[10] = (clone[10] + 10) % 256;
  clone[50] = (clone[50] + 5) % 256;
  return clone;
}

test("captureSnapshot with no provider degrades to unavailable, no camera pipeline", async () => {
  const result = await captureSnapshot({});
  assert.equal(result.available, false);
  assert.equal(result.reason, "no-camera-pipeline");
});

test("captureSnapshot with a working provider returns the buffer", async () => {
  const result = await captureSnapshot({ provider: async () => ({ buffer: staplerImage, mimeType: "image/png" }) });
  assert.equal(result.available, true);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.mimeType, "image/png");
});

test("computeImageHash is deterministic and same-length for any valid image", () => {
  const h1 = computeImageHash(staplerImage);
  const h2 = computeImageHash(staplerImage);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  assert.match(h1, /^[01]{64}$/);
});

test("hammingDistance(0) for identical hashes, large for very different images", () => {
  const h1 = computeImageHash(staplerImage);
  const h2 = computeImageHash(mugImage);
  assert.equal(hammingDistance(h1, h1), 0);
  assert.ok(hammingDistance(h1, h2) > 10, "gradient and its mirror should read as clearly different");
});

test("learnObject saves a labeled entry plus a reference image on disk", () => {
  const result = learnObject(name, "  the Stapler  ", staplerImage, { mimeType: "image/png" });
  assert.equal(result.saved, true);
  assert.equal(result.entry.label, "the Stapler");
  assert.match(result.entry.imagePath, /^learned-objects[/\\].*\.png$/);

  const stored = JSON.parse(fs.readFileSync(objectsFile, "utf8"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].label, "the Stapler");
  assert.ok(fs.existsSync(path.join(dir, stored[0].imagePath)));
});

test("recognizeObject matches a near-duplicate snapshot of a learned object", () => {
  const match = recognizeObject(name, nearDuplicate(staplerImage));
  assert.ok(match, "expected a match for a near-duplicate image");
  assert.equal(match.label, "the Stapler");
});

test("recognizeObject returns null for a clearly different, unlearned image", () => {
  assert.equal(recognizeObject(name, mugImage), null);
});

test("runObjectLearningStep is a no-op unless the task is explicitly assigned", async () => {
  const connection = {};
  const result = await runObjectLearningStep(connection, name, { assigned: false });
  assert.equal(result.status, "not-assigned");
  assert.equal(connection.pendingObjectLearning, undefined);
});

test("runObjectLearningStep recognizes an already-learned object without asking", async () => {
  const connection = {};
  const result = await runObjectLearningStep(connection, name, { assigned: true }, {
    provider: async () => ({ buffer: nearDuplicate(staplerImage) }),
  });
  assert.equal(result.status, "recognized");
  assert.equal(result.label, "the Stapler");
  assert.equal(connection.pendingObjectLearning, undefined);
});

test("runObjectLearningStep asks a question and records a pending snapshot for a new object", async () => {
  const connection = {};
  const result = await runObjectLearningStep(connection, name, { assigned: true }, {
    provider: async () => ({ buffer: mugImage, mimeType: "image/jpeg" }),
  });
  assert.equal(result.status, "unknown");
  assert.equal(typeof result.question, "string");
  assert.ok(connection.pendingObjectLearning);
  assert.ok(Buffer.isBuffer(connection.pendingObjectLearning.buffer));
});

test("extractLabelFromReply strips filler phrasing down to the object name", () => {
  assert.equal(extractLabelFromReply("It's a stapler."), "stapler");
  assert.equal(extractLabelFromReply("that's called a coffee mug"), "coffee mug");
  assert.equal(extractLabelFromReply("an apple"), "apple");
  assert.equal(extractLabelFromReply("stapler"), "stapler");
});

test("resolvePendingObjectLabel saves the reply as the label for the pending snapshot", () => {
  const connection = { pendingObjectLearning: { buffer: mugImage, mimeType: "image/jpeg", askedAt: Date.now() } };
  const result = resolvePendingObjectLabel(connection, name, "it's a coffee mug");
  assert.equal(result.resolved, true);
  assert.equal(result.label, "coffee mug");
  assert.equal(connection.pendingObjectLearning, undefined);

  const stored = JSON.parse(fs.readFileSync(objectsFile, "utf8"));
  assert.equal(stored.length, 2);
  assert.equal(stored[1].label, "coffee mug");

  // The just-learned mug is now recognized on a future encounter.
  const match = recognizeObject(name, nearDuplicate(mugImage));
  assert.equal(match.label, "coffee mug");
});
