import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../helpers/tmp.js";

const dir = makeTmpDir();
fs.mkdirSync(path.join(dir, "data"));
fs.writeFileSync(
  path.join(dir, "data", "phrase-manifest.json"),
  JSON.stringify({ Fact: [{ text: "first" }, { text: "second" }], filler: [{ text: "hmm" }], Bad: "notarray" }),
);
process.chdir(dir);
const { lookupCannedText } = await import("../../src/cannedResponses.js");

test("stall categories, unknown categories and non-array entries give undefined", () => {
  assert.equal(lookupCannedText("filler", "filler_0"), undefined);
  assert.equal(lookupCannedText("Nope", "Nope_0"), undefined);
  assert.equal(lookupCannedText("Bad", "Bad_0"), undefined);
});

test("out-of-range, negative, fractional and non-numeric indexes give undefined", () => {
  for (const id of ["Fact_2", "Fact_99999", "Fact_-1", "Fact_1.5", "Fact_abc", "Fact_", "Fact_1e0x", "Fact_NaN", "Fact_Infinity", "Fact_ 1", "Fact_0x1", "Fact_1e0"]) {
    assert.equal(lookupCannedText("Fact", id), undefined, id);
  }
});

test("mismatched prefix or missing arguments give undefined", () => {
  assert.equal(lookupCannedText("Fact", "Other_0"), undefined);
  assert.equal(lookupCannedText("", "Fact_0"), undefined);
  assert.equal(lookupCannedText("Fact", ""), undefined);
  assert.equal(lookupCannedText(undefined, undefined), undefined);
});

test("prototype-ish category names do not resolve", () => {
  assert.equal(lookupCannedText("__proto__", "__proto___0"), undefined);
  assert.equal(lookupCannedText("constructor", "constructor_0"), undefined);
});
