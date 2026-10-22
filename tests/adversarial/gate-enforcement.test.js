import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Structural checks that keep the test gate the only road to main (TESTING-GATE.md section 6).

const scriptsDir = path.resolve("scripts");
const scriptFiles = fs.readdirSync(scriptsDir).filter((n) => /\.(js|mjs)$/.test(n));
const read = (name) => fs.readFileSync(path.join(scriptsDir, name), "utf8");

test("no script outside lib/gate.js runs git merge or git push", () => {
  const offenders = scriptFiles.filter((n) => /["'](?:merge|push)["']/.test(read(n)));
  assert.deepEqual(offenders, []);
});

test("no source file outside scripts/lib/gate.js runs git merge or git push", () => {
  const roots = ["src", "server.js"];
  const files = [];
  const walk = (p) => {
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach((n) => walk(path.join(p, n)));
    else if (p.endsWith(".js")) files.push(p);
  };
  roots.forEach((r) => walk(path.resolve(r)));
  const offenders = files.filter((f) => /\bgit\b[^;\n]*["'](?:merge|push)["']/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("every script that runs Claude with edit rights uses the gate", () => {
  const offenders = scriptFiles.filter((n) => {
    const src = read(n);
    return src.includes("bypassPermissions") && !/from ["']\.\/lib\/gate\.js["']/.test(src);
  });
  assert.deepEqual(offenders, []);
});

test("gate hooks exist, are executable, and call the gate check", () => {
  for (const hook of ["pre-push", "pre-merge-commit"]) {
    const p = path.resolve(".githooks", hook);
    assert.ok(fs.existsSync(p), `${hook} missing`);
    assert.ok(fs.statSync(p).mode & 0o100, `${hook} not executable`);
    assert.match(fs.readFileSync(p, "utf8"), /gate-check\.js/);
  }
});

test("package.json keeps the gate's test scripts", () => {
  const { scripts } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const s of ["test", "test:green", "test:adversarial", "gate", "install-hooks"]) assert.ok(scripts[s], `${s} script missing`);
  assert.match(scripts["test:green"], /tests\/green/);
  assert.match(scripts["test:adversarial"], /tests\/adversarial/);
});
