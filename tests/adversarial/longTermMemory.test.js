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
  UnknownPersonalityError,
} from "../../src/longTermMemory.js";

const name = `_ltm_adv_${process.pid}`;
const dir = path.join(process.cwd(), "personalities", name);
const file = path.join(dir, "memory.json");
const insightsFile = path.join(dir, "insights.json");
fs.mkdirSync(dir, { recursive: true });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const backups = () => fs.readdirSync(dir).filter((f) => f.startsWith("memory.json.corrupt-"));

test("corrupt file is preserved as a backup, not lost", () => {
  const bad = '[{"fact":"precious","tags":[],"savedAt":"x"},';
  fs.writeFileSync(file, bad);
  assert.equal(getLongTermMemoryBlock(name), "");
  appendMemoryFact(name, "new fact");
  const b = backups();
  assert.equal(b.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, b[0]), "utf8"), bad);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((f) => f.fact), ["new fact"]);
});

test("valid JSON that is not an array is also backed up", () => {
  fs.writeFileSync(file, '{"a":1}');
  const before = backups().length;
  appendMemoryFact(name, "another");
  assert.equal(backups().length, before + 1);
});

test("unreadable path (directory) throws instead of overwriting", () => {
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  assert.throws(() => appendMemoryFact(name, "x"));
  fs.rmdirSync(file);
});

test("readMemoryFacts throws a clear error instead of crashing on a missing file", () => {
  fs.rmSync(file, { force: true });
  assert.throws(() => readMemoryFacts(name), /No memory\.json/);
});

test("readMemoryFacts throws a clear error instead of crashing on unparseable JSON", () => {
  fs.writeFileSync(file, '[{"fact":"broken",');
  assert.throws(() => readMemoryFacts(name), /not valid JSON/);
});

test("readMemoryFacts throws a clear error instead of crashing on a non-array top level", () => {
  fs.writeFileSync(file, '{"fact":"not an array"}');
  assert.throws(() => readMemoryFacts(name), /not a JSON array/);
});

test("removeMemoryFact rejects an out-of-range index without touching the file", () => {
  const original = JSON.stringify([{ fact: "only one", tags: [], savedAt: "2024-01-01T00:00:00.000Z" }]);
  fs.writeFileSync(file, original);
  assert.throws(() => removeMemoryFact(name, 5), /out of range/);
  assert.throws(() => removeMemoryFact(name, -1), /out of range/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(file + ".tmp"), false);
});

test("removeMemoryFact refuses to write if the remaining entries would be invalid", () => {
  const original = JSON.stringify([
    { fact: "valid one", tags: [], savedAt: "2024-01-01T00:00:00.000Z" },
    { fact: "", tags: [], savedAt: "2024-01-01T00:00:00.000Z" },
  ]);
  fs.writeFileSync(file, original);
  assert.throws(() => removeMemoryFact(name, 0), /Refusing to write invalid memory\.json/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(file + ".tmp"), false);
});

test("removeMemoryFact propagates the same clean errors as readMemoryFacts for a missing or corrupt file", () => {
  fs.rmSync(file, { force: true });
  assert.throws(() => removeMemoryFact(name, 0), /No memory\.json/);
  fs.writeFileSync(file, "not json at all");
  assert.throws(() => removeMemoryFact(name, 0), /not valid JSON/);
  fs.writeFileSync(file, '{"not":"an array"}');
  assert.throws(() => removeMemoryFact(name, 0), /not a JSON array/);
});

test("readInsights throws a clear error instead of crashing on a missing, unparseable, or non-array insights.json", () => {
  fs.rmSync(insightsFile, { force: true });
  assert.throws(() => readInsights(name), /No insights\.json/);
  fs.writeFileSync(insightsFile, '[{"insight":"broken",');
  assert.throws(() => readInsights(name), /not valid JSON/);
  fs.writeFileSync(insightsFile, '{"insight":"not an array"}');
  assert.throws(() => readInsights(name), /not a JSON array/);
});

test("removeInsight rejects an out-of-range index without touching the file", () => {
  const original = JSON.stringify([
    { insight: "only one", sourceTags: [], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
  ]);
  fs.writeFileSync(insightsFile, original);
  assert.throws(() => removeInsight(name, 5), /out of range/);
  assert.throws(() => removeInsight(name, -1), /out of range/);
  assert.throws(() => removeInsight(name, 1.5), /out of range/);
  assert.equal(fs.readFileSync(insightsFile, "utf8"), original);
  assert.equal(fs.existsSync(insightsFile + ".tmp"), false);
});

test("removeInsight refuses to write if the remaining entries would be invalid", () => {
  const original = JSON.stringify([
    { insight: "valid one", sourceTags: [], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
    { insight: "", sourceTags: [], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
  ]);
  fs.writeFileSync(insightsFile, original);
  assert.throws(() => removeInsight(name, 0), /Refusing to write invalid insights\.json/);
  assert.equal(fs.readFileSync(insightsFile, "utf8"), original);
  assert.equal(fs.existsSync(insightsFile + ".tmp"), false);
});

test("removeInsight propagates the same clean errors as readInsights for a missing or corrupt file", () => {
  fs.rmSync(insightsFile, { force: true });
  assert.throws(() => removeInsight(name, 0), /No insights\.json/);
  fs.writeFileSync(insightsFile, "not json at all");
  assert.throws(() => removeInsight(name, 0), /not valid JSON/);
  fs.writeFileSync(insightsFile, '{"not":"an array"}');
  assert.throws(() => removeInsight(name, 0), /not a JSON array/);
});

test("getMemorySnapshot's index field survives among hostile/malformed sibling entries", () => {
  fs.writeFileSync(
    file,
    JSON.stringify([
      null,
      { fact: "keep me", tags: [], savedAt: "2024-01-01T00:00:00.000Z" },
      42,
      "just a string",
    ]),
  );
  const snapshot = getMemorySnapshot(name);
  assert.equal(snapshot.facts.length, 4);
  const keeper = snapshot.facts.find((f) => f.fact === "keep me");
  // Index 1, matching its position in the raw file above, not wherever it
  // landed in the (newest-first-sorted) snapshot array.
  assert.equal(keeper.index, 1);
  // removeMemoryFact validates the *entire* remaining array before writing
  // (see src/longTermMemory.js), so pointing it at a file whose other
  // entries are themselves malformed still refuses rather than silently
  // writing corrupt JSON back out — even though the index itself is
  // correct and the target entry is fine.
  assert.throws(() => removeMemoryFact(name, keeper.index), /Refusing to write invalid memory\.json/);
});

test("getMemorySnapshot rejects an unknown personality instead of reading arbitrary paths", () => {
  assert.throws(
    () => getMemorySnapshot("../../etc"),
    (err) => err instanceof UnknownPersonalityError,
  );
  assert.throws(
    () => getMemorySnapshot(`_ltm_adv_does_not_exist_${process.pid}`),
    (err) => err instanceof UnknownPersonalityError,
  );
});

test("getMemorySnapshot degrades malformed memory.json/insights.json to empty lists instead of throwing", () => {
  fs.writeFileSync(file, '[{"fact":"broken",');
  fs.writeFileSync(insightsFile, "not json at all");
  const snapshot = getMemorySnapshot(name);
  assert.deepEqual(snapshot, { facts: [], insights: [] });
});

test("getMemorySnapshot degrades a non-array top level to empty lists", () => {
  fs.writeFileSync(file, '{"fact":"not an array"}');
  fs.writeFileSync(insightsFile, '{"insight":"not an array"}');
  const snapshot = getMemorySnapshot(name);
  assert.deepEqual(snapshot, { facts: [], insights: [] });
});

test("getMemorySnapshot normalizes hostile/malformed entries field-by-field instead of crashing", () => {
  fs.writeFileSync(
    file,
    JSON.stringify([
      null,
      42,
      "just a string",
      { fact: 12345, tags: "not-an-array", savedAt: { nested: true } },
      { fact: "ok fact", tags: [1, "real-tag", null], savedAt: "2024-01-01T00:00:00.000Z" },
    ]),
  );
  fs.writeFileSync(
    insightsFile,
    JSON.stringify([
      [],
      { insight: null, sourceTags: null, status: 7, createdAt: "not-a-date" },
      { insight: "ok insight", sourceTags: ["a", 2], status: "approved", createdAt: "2024-01-01T00:00:00.000Z" },
    ]),
  );

  const snapshot = getMemorySnapshot(name);
  assert.equal(snapshot.facts.length, 5);
  assert.deepEqual(snapshot.facts.map((f) => f.fact).sort(), ["", "", "", "", "ok fact"]);
  const okFact = snapshot.facts.find((f) => f.fact === "ok fact");
  assert.deepEqual(okFact.tags, ["real-tag"]);

  assert.equal(snapshot.insights.length, 3);
  const okInsight = snapshot.insights.find((i) => i.insight === "ok insight");
  assert.deepEqual(okInsight.sourceTags, ["a"]);
  const brokenInsight = snapshot.insights.find((i) => i.createdAt === "not-a-date");
  assert.equal(brokenInsight.insight, "");
  assert.equal(brokenInsight.status, "");
});
