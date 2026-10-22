# Test Gate — spec (signed off 2026-09-19, implemented)

**Hard rule:** every automated process or signed-off job that builds or changes
code goes through one shared gate before anything reaches `main`. No gate pass,
no merge, no push. No exceptions, including jobs specced later.

## 1. Suites

Both run offline (no network, no API keys, no running server), via `node:test`, no new dependencies.

| Suite | Path | npm script | Purpose |
|---|---|---|---|
| Green path | `tests/green/*.test.js` | `test:green` | Valid input produces the documented output. |
| Adversarial | `tests/adversarial/*.test.js` | `test:adversarial` | Hostile or malformed input fails safely: no crash, no leak, no raw-JSON-spoken-aloud, no state corruption. |

`npm test` runs both. Adversarial coverage per function: empty/null/wrong-type
input, oversized input, unicode/control chars, CRLF, path traversal in
filenames/slugs, prototype-pollution keys, prompt/JSON injection strings,
out-of-range indexes, repeated/out-of-order calls on state machines.

Initial targets (from the pending offline-suite task): `resolveEffectiveMode`,
`parseDeepThoughtfulOutput`, `getCustomTools`, `taskFile.js`, `lookupCannedText`,
`wrapPcmAsWav`, plus the gate library itself.

## 2. Gate stages (`scripts/lib/gate.js` → `runGate(worktree)`)

1. `node --check` on all JS.
2. `test:green`.
3. `test:adversarial`.
4. Webapp build if `webapp/` changed.
5. Server boot smoke test (reuse `smokeBoot` from `run-cleanup.js`).
6. **Test-presence check:** a diff touching `src/`, `server.js` or `scripts/` must add or modify tests in *both* suites.
7. **Ratchet:** test count per suite may not drop vs `main`; deleting or skipping (`.skip`, `.todo`, `only`) tests fails the gate. This is **not** looped on: the change is discarded and logged as `needs_review` for a human (Claude is told to leave tested dead code in place and report it).
8. **Coverage of added lines:** every added executable line under `src/` or `scripts/lib/` must be hit by the suites (Node's built-in coverage, both suites merged). A file no test loads counts as uncovered. Entry-point scripts and `server.js` are exempt (they run on import; the boot check covers them), so logic in them should live in `src/`.

The test-presence check (6) is switched off for `run-cleanup.js`, since a behavior-preserving cleanup needn't add tests; rule 8 still applies to any line it adds.

Any stage failing = round failed.

## 3. Fix loop and oscillation exit

- Failures are fed back to the same Claude session (`--resume`, as `run-cleanup.js` does).
- Each failure gets a fingerprint: `stage + test name + normalized error message`. Round history is kept.
- **Oscillation rule:** if any fingerprint appears in **3 separate rounds**
  (covers "fix adversarial → green breaks → fix green → adversarial breaks"),
  the gate aborts.
- Backstop: absolute cap of 8 rounds.
- Loop ends only on: all stages clean, oscillation exit, or backstop.

## 4. Abort path (oscillation / backstop / timeout)

- Nothing is merged or pushed. `main` is untouched; worktree and branch are discarded.
- Task moves to `tasks/failed/` with a note.
- Write `logs/gate-failure-<timestamp>.json`: task, per-round stage results, the repeating fingerprint(s), the diff of each round.
- Job exits non-zero.
- No auto-retry (matches the current build runner).

## 5. Success path

Gate clean → commit → merge → restart/health check (rollback on unhealthy) → **push**. `run-build-task.js` did not push before; it now does. Gate result is recorded in the run log.

## 6. Enforcement (making it structural, not a convention)

1. **Single landing function.** `landMerge()` / `landPush()` in `scripts/lib/gate.js` are the only code that runs `git merge` or `git push` for automated work. `run-build-task.js` and `run-cleanup.js` are refactored to use them.
2. **Gate stamp.** A pass writes `.git/gate-pass/<tree-sha>`. Repo git hooks (`pre-merge-commit`, `pre-push`) refuse without a stamp for the tree being landed. Bypassing means `--no-verify`, which is a deliberate act.
3. **Self-check test.** An adversarial test scans `scripts/` and fails if any file outside `scripts/lib/gate.js` calls `git merge`/`git push`.
4. **Build prompts.** The gate rules ("add green + adversarial tests; do not weaken tests") are appended to every build/cleanup prompt centrally, so job specs can't omit them.
5. **New-job check.** An adversarial test fails if any script that runs Claude with `bypassPermissions` doesn't import the gate. Approved task specs get the gate rules through the build prompt (item 4).
6. **Interactive sessions.** This rule is stored in project memory so my own edits follow it too.

## 7. Scope of "processes that change things"

- **Code-changing (full gate):** `run-build-task.js`, `run-cleanup.js`, any future job.
- **Data-only writers** (`run-ideation.js` writes task files, `run-reflection.js` writes insight JSON, `approve-*`/`reject-*` move files): they don't land code, so they get a light gate: schema validation of what they write (task frontmatter, insights JSON) with green + adversarial cases in the same suites.

## 8. Rollout order

1. Write the suites and `test:*` scripts (supersedes the pending offline-suite task; that task's "don't mock API clients" rule stays).
2. Build `scripts/lib/gate.js` with the fix loop, oscillation detector and abort logging; unit-test the detector itself.
3. Refactor build + cleanup runners onto `runFixLoop` / `landMerge` / `landPush`.
4. Hooks, self-check test, prompt injection, spec template.
5. Data-writer light gate.

## Decisions (signed off)

- Added code must be covered; test removal needs human review; presence relaxed for cleanup only (signed off 2026-09-19).

- 8-round backstop, 3-repeat threshold: confirmed.
- Data-only writers get the light gate: confirmed.
- Hooks apply to manual pushes and merges too: confirmed. `git push --no-verify` remains git's own escape hatch; don't use it.
