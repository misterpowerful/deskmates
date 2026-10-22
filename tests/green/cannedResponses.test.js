import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../helpers/tmp.js";

const dir = makeTmpDir();
fs.mkdirSync(path.join(dir, "data"));
fs.writeFileSync(
  path.join(dir, "data", "phrase-manifest.json"),
  JSON.stringify({ Fact: [{ text: "first" }, { text: "second" }], filler: [{ text: "hmm" }] }),
);
process.chdir(dir);
const { lookupCannedText } = await import("../../src/cannedResponses.js");

test("resolves the index in the line id to manifest text", () => {
  assert.equal(lookupCannedText("Fact", "Fact_0"), "first");
  assert.equal(lookupCannedText("Fact", "Fact_1"), "second");
});
