import fs from "node:fs";
import path from "node:path";
import { makeTmpRepo } from "./tmp.js";

// A tiny ESM project on branch main (src/a.js only), for running the real gate against.
export function makeFixture() {
  const repo = makeTmpRepo();
  fs.writeFileSync(path.join(repo.dir, "package.json"), JSON.stringify({ type: "module" }));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "package");
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, rel), content);
  };
  const testFile = (body) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as a from "../../src/a.js";\n${body}\n`;
  return { ...repo, write, testFile };
}
