import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  appendMemoryFact,
  getLongTermMemoryBlock,
  getMemorySnapshot,
  readInsights,
  readMemoryFacts,
  removeInsight,
  removeMemoryFact,
} from "../../src/longTermMemory.js";

const name = `_ltm_green_${process.pid}`;
const dir = path.join(process.cwd(), "personalities", name);
const file = path.join(dir, "memory.json");
const insightsFile = path.join(dir, "insights.json");
fs.mkdirSync(dir, { recursive: true });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("missing file is created on first append", () => {
  fs.rmSync(file, { force: true });
  const e = appendMemoryFact(name, "likes jazz", ["music"]);
  assert.equal(e.fact, "likes jazz");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((f) => f.fact), ["likes jazz"]);
  assert.equal(fs.existsSync(file + ".tmp"), false);
});

test("normal append adds a second fact", () => {
  appendMemoryFact(name, "owns a cat");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 2);
  assert.match(getLongTermMemoryBlock(name), /owns a cat/);
});

test("exact duplicate (normalized) is skipped and returns existing entry", () => {
  const first = JSON.parse(fs.readFileSync(file, "utf8"))[0];
  const e = appendMemoryFact(name, "  Likes   JAZZ ");
  assert.equal(e.savedAt, first.savedAt);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 2);
});

test("getMemorySnapshot returns facts newest-first with tags, and insights newest-first with status", () => {
  fs.writeFileSync(
    file,
    JSON.stringify([
      { fact: "owns a cat", tags: ["pets"], savedAt: "2024-01-01T00:00:00.000Z" },
      { fact: "likes jazz", tags: ["music"], savedAt: "2024-06-01T00:00:00.000Z" },
    ]),
  );
  fs.writeFileSync(
    insightsFile,
    JSON.stringify([
      { insight: "older one", sourceTags: ["music"], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
      { insight: "newer one", sourceTags: ["pets"], status: "approved", createdAt: "2024-06-01T00:00:00.000Z" },
    ]),
  );

  const snapshot = getMemorySnapshot(name);
  assert.deepEqual(snapshot.facts.map((f) => f.fact), ["likes jazz", "owns a cat"]);
  assert.deepEqual(snapshot.facts[0].tags, ["music"]);
  assert.deepEqual(snapshot.insights.map((i) => i.insight), ["newer one", "older one"]);
  assert.equal(snapshot.insights[0].status, "approved");
});

test("removeMemoryFact deletes the entry at a valid index and leaves the rest intact", () => {
  fs.writeFileSync(
    file,
    JSON.stringify([
      { fact: "likes jazz", tags: ["music"], savedAt: "2024-01-01T00:00:00.000Z" },
      { fact: "owns a cat", tags: ["pets"], savedAt: "2024-02-01T00:00:00.000Z" },
      { fact: "hates mondays", savedAt: "2024-03-01T00:00:00.000Z" },
    ]),
  );
  const removed = removeMemoryFact(name, 1);
  assert.equal(removed.fact, "owns a cat");
  const remaining = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(remaining.map((f) => f.fact), ["likes jazz", "hates mondays"]);
  assert.equal(fs.existsSync(file + ".tmp"), false);
  assert.deepEqual(readMemoryFacts(name), remaining);
});

test("removeInsight deletes the entry at a valid index and leaves the rest intact", () => {
  fs.writeFileSync(
    insightsFile,
    JSON.stringify([
      { insight: "likes jazz a lot", sourceTags: ["music"], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
      { insight: "owns several cats", sourceTags: ["pets"], status: "approved", createdAt: "2024-02-01T00:00:00.000Z" },
      { insight: "dislikes mondays", sourceTags: ["mood"], status: "approved", createdAt: "2024-03-01T00:00:00.000Z" },
    ]),
  );
  const removed = removeInsight(name, 1);
  assert.equal(removed.insight, "owns several cats");
  const remaining = JSON.parse(fs.readFileSync(insightsFile, "utf8"));
  assert.deepEqual(remaining.map((i) => i.insight), ["likes jazz a lot", "dislikes mondays"]);
  assert.equal(fs.existsSync(insightsFile + ".tmp"), false);
  assert.deepEqual(readInsights(name), remaining);
});

test("getMemorySnapshot exposes each entry's on-disk index, not its position in the sorted output", () => {
  fs.writeFileSync(
    file,
    JSON.stringify([
      { fact: "oldest fact, index 0", tags: [], savedAt: "2024-01-01T00:00:00.000Z" },
      { fact: "newest fact, index 1", tags: [], savedAt: "2024-06-01T00:00:00.000Z" },
    ]),
  );
  fs.writeFileSync(
    insightsFile,
    JSON.stringify([
      { insight: "oldest insight, index 0", sourceTags: [], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
      { insight: "newest insight, index 1", sourceTags: [], status: "approved", createdAt: "2024-06-01T00:00:00.000Z" },
    ]),
  );

  const snapshot = getMemorySnapshot(name);
  // Newest-first in the output, but each entry still carries its original
  // (pre-sort) file index so a client can hand it straight back to
  // removeMemoryFact/removeInsight and delete the right one.
  assert.deepEqual(snapshot.facts.map((f) => [f.fact, f.index]), [
    ["newest fact, index 1", 1],
    ["oldest fact, index 0", 0],
  ]);
  assert.deepEqual(snapshot.insights.map((i) => [i.insight, i.index]), [
    ["newest insight, index 1", 1],
    ["oldest insight, index 0", 0],
  ]);

  // And that index is exactly what removeMemoryFact/removeInsight expect:
  // deleting by the snapshot's reported index removes the right entry.
  const target = snapshot.facts.find((f) => f.fact === "oldest fact, index 0");
  const removed = removeMemoryFact(name, target.index);
  assert.equal(removed.fact, "oldest fact, index 0");
});

test("getMemorySnapshot returns empty lists when neither file exists yet", () => {
  const other = `_ltm_green_empty_${process.pid}`;
  const otherDir = path.join(process.cwd(), "personalities", other);
  fs.mkdirSync(otherDir, { recursive: true });
  try {
    assert.deepEqual(getMemorySnapshot(other), { facts: [], insights: [] });
  } finally {
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});
