# Deskmates: setup and operations guide

WebSocket backend for the Deskmates desk-companion voice AI. Bridges the client
over `wss://your-domain.example.com` to Anthropic (LLM) and
ElevenLabs (speech-to-text and text-to-speech), plus a canned-response
system for instant filler/error lines that don't need a live pipeline call.

## 1. Fill in `.env`

`.env` already exists at the project root with placeholders and a comment
above each key explaining what it's for. Fill in:

- `ANTHROPIC_API_KEY` — from the Anthropic Console.
- `ELEVENLABS_API_KEY` — from the ElevenLabs dashboard.
- **Clock / timezone (no env var).** Gatsby's time comes from the server:
  each connection's client IP is resolved to an IANA timezone with the
  offline `geoip-lite` database, and every turn is prefixed with a
  `[TIME: ...]` tag. Behind nginx the real IP is read from `X-Real-IP`
  (else the last `X-Forwarded-For` entry) — and only when the direct peer is
  loopback, so it can't be spoofed. The nginx site must therefore set
  `proxy_set_header X-Real-IP $remote_addr;`. Carrier/hotspot IPs sometimes
  geolocate wrong: `config.json` has `default_timezone` (used when the lookup
  fails) and an optional `timezone_override` that pins the zone outright.
- `GITHUB_PAT` — a GitHub fine-grained personal access token, used by
  deep_thoughtful mode's GitHub tool to read and write files across
  repositories. Generate at github.com → Settings → Developer settings →
  Personal access tokens → Fine-grained tokens. Repository access: "All
  repositories". Permissions: Contents — Read and write. Treat this like
  any other production secret: never commit it, never paste it into a
  chat, rotate it if it's ever exposed.
- `BOT_AUTH_TOKEN` — make up any strong random secret (e.g.
  `openssl rand -hex 32`). This is the shared secret the bot must send as
  the `X-Butterbot-Token` header when it opens the WebSocket connection —
  the server rejects the connection outright if it doesn't match exactly.
  **The server refuses to start at all if this is blank** — that's
  intentional, not a bug.
- `PORT` — already set to `8080`; only change it if you also update the
  `proxy_pass` target in `/etc/nginx/sites-available/deskmates`.
- `GITHUB_PAT` — a fine-grained GitHub personal access token, scoped to
  **all repositories** with **Contents: Read and write**. Powers the
  `github_read_file`/`github_propose_write`/`github_confirm_write`/
  `github_list_repos` tools available in `deep_thoughtful` mode — writes are
  two-step (propose, then an explicit confirm on a later turn) — see
  `CAPABILITIES.md`'s "External tools" section for the full behavior.
  Deliberately separate from `GITHUB_TOKEN`, which is only used for this
  repo's own git-push credential storage (`run-build-task.js`'s automated
  commits) and has nothing to do with the live conversational tools.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a Google Cloud Console
  project with the Gmail API and Calendar API enabled, and an OAuth 2.0
  **Desktop app** client created. Powers the Gmail and Calendar tools.
- `GOOGLE_REFRESH_TOKEN` — obtained via the one-time setup in section 2
  below, not something you type in by hand.
- `DEEP_THOUGHTFUL_PROVIDER` — optional, `api` (default, omit the var
  entirely for this) or `claude-code`. Controls which model actually
  executes `deep_thoughtful`'s tool loop: `api` calls
  `anthropic.messages.create()` directly, billed against
  `ANTHROPIC_API_KEY`; `claude-code` routes the same loop through the Claude
  Agent SDK instead, billed against `CLAUDE_CODE_OAUTH_TOKEN`'s subscription.
  **`claude-code` refuses to run at all if `CLAUDE_CODE_OAUTH_TOKEN` isn't
  set** — every deep_thoughtful turn fails immediately with a clear error
  (logged, and returned to the caller as `text_error`/`speech_error`)
  instead of silently authenticating with `ANTHROPIC_API_KEY` and spending
  metered API money. The server also logs a WARNING line at startup if this
  misconfiguration is present. `friendly` mode is never affected by this
  var; it always uses the API path.
- `CLAUDE_CODE_OAUTH_TOKEN` — needed for `DEEP_THOUGHTFUL_PROVIDER=
  claude-code` **and** for async task delegation's background workers (see
  CAPABILITIES.md's "Async task delegation" section) — both run through
  the `claude` CLI/Agent SDK rather than `ANTHROPIC_API_KEY`, so both need
  this to actually bill against your subscription instead of metered API
  spend. Generate it by running `claude setup-token` on this box
  (interactive browser OAuth login tied to your own Claude Pro/Max/Team
  subscription — there's no way to script this step) and pasting the token
  it prints here. Once this is set, both paths strip `ANTHROPIC_API_KEY`
  from their own subprocess environment so the subscription token can't be
  silently outranked by the API key this same server also uses for
  `friendly` mode's live conversation.
- `TASK_RETENTION_DAYS` — optional, default `7`. How long a delegated
  task's result sticks around in `delegated-tasks/` after it's been heard
  (`get_task_result`) before the hourly sweep deletes it. An unheard
  result is never deleted regardless of age.
- `WORKER_MAX_TURNS` — optional, default `15`. Passed to each delegated
  task's `claude -p --max-turns` call — a hard ceiling on how many
  tool-use turns one worker can take before it has to answer with
  whatever it has.
- `WORKER_TIMEOUT_MS` — optional, default `300000` (5 minutes). Wall-clock
  limit per delegated task; the worker subprocess is killed (`SIGKILL`) and
  the task marked "failed" if it runs longer than this.
- `WORKER_CONCURRENCY` — optional, default `2`. Max number of delegated
  workers running at once; anything beyond that queues. Kept low because
  these workers share the same Claude subscription/plan limits as every
  other `claude-code`-routed call this server makes.
- `WORKER_ALLOWED_TOOLS` — optional, comma-separated, overrides the
  default `--allowedTools` list passed to each worker (web search/fetch
  plus read/search/draft-only Gmail, read/create Calendar, read/create
  Drive — see `src/delegatedTasks.js`'s `DEFAULT_ALLOWED_TOOLS`). The
  default Gmail/Drive tool names were confirmed against this account's
  actually-connected MCP connectors; the Calendar connector was not
  authorized when this was written, so its two names are an unverified
  best guess at the same naming convention — once it's authorized, run
  `claude -p "list your Google Calendar MCP tool names as a JSON array"
  --output-format json` to confirm (or correct) them, and set this var if
  they differ. An unmatched tool name is harmless either way — the CLI
  just grants nothing for it rather than erroring.
- `ALLOW_CLAUDE_CODE_API_FALLBACK` — optional, default off (unset/anything
  other than `true`). When a `claude-code`-routed call throws (SDK/CLI
  error, not the missing-token case above), the default behavior is to
  surface the error as a failed turn rather than spend API money the
  `claude-code` routing was specifically chosen to avoid. Set to `true` to
  instead retry that turn via the metered Anthropic API on failure — a
  warning is logged either way.
- `RATE_LIMIT_UTILIZATION_SCALE` — optional, `fraction` or `percent`. The
  Usage tab's plan meters come from the Agent SDK's `rate_limit_event`
  messages (logged during `claude-code` turns). The SDK doesn't document
  whether their `utilization` is 0–1 or 0–100, so by default the server
  guesses from the largest value seen (≤ 1 → fraction). Once you've
  confirmed which one it is (compare against `/usage` in Claude Code),
  pin it here so a low reading like 0.6% isn't misread as 60%.

After editing `.env`, restart the service so it picks up the new values:

```bash
sudo systemctl restart deskmates
sudo systemctl status deskmates   # should show "active (running)" with no FATAL line
```

`.env` is gitignored — it never gets committed.

## 2. One-time Google OAuth setup (for the Gmail/Calendar tools)

`GOOGLE_REFRESH_TOKEN` can't be scripted end-to-end — it needs a real
browser and a Google account login, the same way the `sudo systemctl
restart` permission for `run-build-task.js` couldn't be automated. Run this
once, by hand, after `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are in `.env`:

```bash
npm run google-oauth-setup
```

This starts a small local HTTP listener on the server and prints an
authorization URL requesting Gmail (readonly + modify) and Calendar scopes.
Since the listener runs on deskmates's own host but the browser doing the
Google consent runs on your laptop, forward the one fixed port it uses over
SSH while launching the script remotely, in one command:

```bash
ssh -L 8945:127.0.0.1:8945 <user>@<host> \
  'cd /var/www/deskmates && node scripts/google-oauth-setup.js'
```

Open the printed URL in a browser on your laptop as normal; the tunnel
carries Google's redirect back to the script on the server. It prints a
`GOOGLE_REFRESH_TOKEN=...` line — paste that into `.env`, then restart the
service.

## 3. Adding real canned-response audio files

The canned-response folders under `personalities/<name>/canned-responses/`
are empty on purpose. To add a real line, just drop a `pcm_16000`-format
audio file (16-bit PCM, 16kHz, mono — the same format the bot expects back
from `speech_result`/`canned_result`) into the right folder. No
registration, no manifest, no restart needed — the server reads the
directory fresh on every request.

Folder layout, per personality:

```
personalities/<name>/canned-responses/
  shared/<category>/          # used when there's no mode-specific override
  friendly/<category>/        # only used in "friendly" mode
  sentry_intruder/<category>/ # only used in "sentry_intruder" mode
```

Resolution: the server looks in `<mode>/<category>/` first; if that folder
doesn't exist or is empty, it falls back to `shared/<category>/`. If neither
has a file, the bot gets a `canned_error` frame instead of audio — this is
the expected, handled path for any category you haven't recorded lines for
yet.

The filename (without extension) becomes the `line_id` reported back to the
bot. Filenames starting with `.` (like `.gitkeep`) are ignored, so it's safe
to keep a dotfile in an otherwise-empty folder if you want it tracked in
git.

The server avoids repeating the same line too often: it remembers the last
`canned_response_history_window` (see `config.json`) lines played per
mode/category and excludes them from the random pick — unless every file in
the folder is currently excluded, in which case it just picks anyway rather
than getting stuck.

## 4. Adding a new personality

1. Copy the whole `personalities/gatsby-sardonic/` folder to
   `personalities/<your-new-name>/`, keeping the same internal shape
   (`personality-breakdown.md`, `voice-config.json`, `canned-responses/...`,
   `memory.json`).
2. Edit `personality-breakdown.md` — this file's raw contents are sent
   verbatim as Claude's system prompt for every LLM call, so write it the
   way you'd write a system prompt (character, tone, the FRIENDLY /
   SENTRY_INTRUDER mode split, and the "respond only with the spoken line"
   instruction at the end).
3. Edit `voice-config.json` — set `voice_id` to the ElevenLabs voice you
   want for this personality, and `display_name` to the name it should be
   labeled with wherever personality info goes out (console/webapp
   transcript, `list_personalities`). `npm run check-personality` flags a
   personality that's missing it; without one, clients fall back to
   deriving a name from the folder slug, which is only right by
   coincidence.
4. Record or leave empty the `canned-responses/` subfolders as you like —
   same rules as above.
5. Leave `memory.json` as `[]` — it's this personality's long-term-memory
   store (see "Memory" below) and grows on its own once it's live.
6. Switch to it by editing `config.json`'s `active_personality` field to
   your new folder's name. **No restart needed** — `config.json` is read
   fresh on every request. Switching `active_personality` also wipes the
   canned-response "recently played" history, so the new personality starts
   with a clean slate. Switching between `friendly` and `sentry_intruder`
   modes within the same personality does *not* wipe history — only an
   `active_personality` change does.

## 5. Memory

There are two kinds of memory, both scoped per-personality:

- **Session memory** — a rolling in-memory history of the current
  conversation (`config.json`'s `session_memory_max_turns`, default 20). It
  lets the bot handle follow-ups ("make it shorter", "what was the second
  one") within one session. Never written to disk. Cleared when
  `active_personality` changes mid-connection. Storage is keyed by
  `ws.sessionId` when the connection sends one (`src/sessionMemory.js`), so
  a client that reconnects with the same `session_id` — the webapp's
  auto-reconnect, see `WEBAPP.md` — resumes the same turns instead of
  starting empty; the entry is only dropped after a short grace period of
  no reconnect. Connections with no `session_id` (the physical bot,
  console) keep the old behavior: memory lives on the connection object and
  is gone as soon as it closes.
- **Long-term memory** — `personalities/<name>/memory.json`, a flat array
  of `{ fact, savedAt }` entries. Nothing is stored automatically; it only
  grows when someone says a trigger phrase ("remember that...", "remember
  this...", "don't forget...", "keep in mind..." — see the `TRIGGER_PHRASES`
  array at the top of `src/longTermMemory.js`). On trigger, the bot replies
  with the canned `custom-memory_saved` line (record real audio for it the
  same way as any other canned category — see above) instead of a live
  reply, then in the background asks Claude to condense the recent
  conversation into one short fact and appends it to that personality's
  `memory.json`. Facts are injected into the system prompt as a
  `LONG-TERM MEMORY` block on every request. Memory is never shared or
  merged across personalities. Each entry is now `{ fact, tags, savedAt }`
  — `tags` is 1–3 freeform lowercase words the same condensation call
  assigns (e.g. `["music", "preferences"]`); entries saved before tagging
  existed simply have no `tags` field, which every reader treats as `[]`.
  A bad or stale fact can be removed with `npm run reject-memory-fact --
  <personality> <index>`, which prints the entry and asks for confirmation,
  then deletes it and validates the rest of the file before writing — hand-
  editing `memory.json` is no longer the only way to fix a bad entry.

### Reflection & insights

A weekly job looks for patterns across a personality's tagged facts and
writes them up as **insights**, auto-approved on write — no human gate,
unlike the task-approval pipeline below.

- **`scripts/run-reflection.js`** (`0 4 * * 0` — weekly, Sunday, separate
  cadence from the daily ideation/build crons above since it needs a
  bigger sample of accumulated facts than one day produces) groups
  `personalities/<name>/memory.json` facts by tag; any tag with 3+ facts is
  a candidate. For each candidate, Sonnet is asked to state only what the
  facts show — explicitly told not to predict what the person wants next —
  and to say nothing if it can't do that without guessing. A genuine
  observation is appended to `personalities/<name>/insights.json` as
  `{ insight, sourceTags, status: "approved", createdAt }` — live
  immediately. A tag already covered by an existing insight isn't
  reconsidered — that's what keeps two overlapping tags (e.g. "music" and
  "preferences" describing mostly the same facts) from producing duplicate
  observations, this run or a later one.
- `npm run reject-insight -- <personality> <index>` — prints the full
  insight and asks for confirmation, then deletes it outright (no
  rejected-ledger to check going forward — deleting it just frees its
  tag(s) up so the reflection job can reconsider them next week if the
  pattern is still genuinely there). This is now the only way to catch a
  bad auto-approved insight, and only after the fact.
- `npm run approve-insight -- <personality> <index>` — still works, but is
  a no-op for anything `run-reflection.js` produces now; only relevant if
  an insight's `status` is manually reset to `"proposed"`.
- Only `status: "approved"` insights are ever read back — by
  `deep_thoughtful` mode, the same that-mode-only way `CAPABILITIES.md` is
  (see below).

## 6. Generating stock-phrase audio

`data/phrase-manifest.json` holds the ~150 static stock-phrase categories
(~608 lines) as `{ text, rare }` pairs per category. `scripts/generate-stock-phrases.js`
turns that into real `pcm_16000` audio files under a personality's
`canned-responses/shared/<category>/` folders via ElevenLabs TTS. It's a
one-off script, not part of the running server — run it manually, once per
personality, whenever the manifest changes or a new personality needs
stock audio.

```bash
# Preview what would be generated — no API calls, no files written.
npm run generate-stock-phrases -- --personality gatsby-sardonic --dry-run

# Smoke-test the pipeline on a handful of lines before committing to all 608.
npm run generate-stock-phrases -- --personality gatsby-sardonic --limit 5

# Full run.
npm run generate-stock-phrases -- --personality gatsby-sardonic
```

Other flags: `--category <name>` to (re)generate just one category,
`--speed <n>` to override the voice's `speed.friendly` default, `--concurrency <n>`
(default 3) for how many ElevenLabs requests run at once, and `--force` to
regenerate lines whose `.pcm` file already exists (by default, existing
files are skipped — safe to rerun after a crash or after adding new lines
to the manifest). Every real run writes a `logs/generation-<personality>-<timestamp>.json`
listing what was generated, skipped, or failed. Run it once per
personality — `voice_id` differs per personality, so a `--personality`
typo is the way to silently generate 608 files in the wrong voice.

## Testing without hardware

`scripts/test-client.js` opens a real WebSocket connection to a running
server (auth header included), exercises `get_canned`, an ordinary
`speech_request`, and the "remember this" long-term-memory flow, then
checks `memory.json` on disk for the new fact. Test utterances are
synthesized with ElevenLabs TTS and sent through the real STT path — no
mocking, no bot hardware needed. Start the server first, then:

```bash
npm run test-client
```

## Self-improvement pipeline

The bot's codebase evolves over time via `tasks/` files instead of every
change being hand-written. See `CAPABILITIES.md` for what the bot can
currently do — it's regenerated/updated incrementally as this pipeline ships
changes, and `deep_thoughtful` mode reads it live to answer "what can you
do?" questions.

**Per-personality gate (conversational path only):** `config.json`'s
`self_improve_personalities` array lists which `active_personality` values
may use the conversational self-improvement path in
`src/speechPipeline.js` (propose an idea, write straight to
`tasks/pending/`, recall past proposals). Any personality not in that list
gets a `deep_thoughtful` system prompt with the entire "Self-improvement
pipeline" section of `CAPABILITIES.md` cut out, no self-proposals context,
and no `propose_task` output format — so it has no way to know the ability
exists, not just an instruction to stay quiet about it. `isSelfImproveApproved`
in `src/config.js` is the single source of truth for this check. This gate
does not touch the overnight `run-ideation.js`/`run-build-task.js` cron
pipeline below, which is personality-independent and already requires
explicit human approval.

- **`tasks/pending/`** — tasks ready to build. Drop a `.md` file in here
  yourself (frontmatter: `source: human`, `created`, `title`, then a
  free-text description) to have it picked up by the next build run — no
  approval needed, it's already your call.
- Ideas from `scripts/run-ideation.js` (`source: gatsby`) also land in
  `tasks/pending/` directly — there is no approval step.
  `npm run reject-task -- <filename> ["reason"]` moves one to
  `tasks/rejected/`, optionally recording why so the ideation job doesn't
  re-suggest it.
- **`tasks/done/`** / **`tasks/failed/`** — where `scripts/run-build-task.js`
  moves a task once it's been built (with the deployed commit hash) or
  failed (with the rollback reason), respectively.

Two cron jobs drive this (`crontab -l`):

```
0 2 * * * cd /var/www/deskmates && node scripts/run-ideation.js >> logs/cron.log 2>&1
0 0,3 * * * cd /var/www/deskmates && node scripts/run-build-task.js >> logs/cron.log 2>&1
```

- **`prune-turns.js`** (separate daily cron, not part of the build queue)
  deletes turn-log rows (`logs/turns.db`, or `logs/turns.jsonl` on the
  fallback path) older than `turn_log_retention_days` in `config.json`
  (default 90; a missing or invalid value also means 90) and VACUUMs so disk
  space is reclaimed. Turns hold verbatim transcripts, so they are aged out
  rather than kept forever. It logs the day count, cutoff, and rows deleted:

  ```
  30 4 * * * cd /var/www/deskmates && node scripts/prune-turns.js >> logs/cron.log 2>&1
  ```

- **`prune-job-logs.js`** (separate daily cron, not part of the build queue)
  deletes the per-run JSON logs the jobs below write on every run
  (`logs/self-build-*.json`, `self-ideation-*.json`, `self-cleanup-*.json`/
  `.patch`, `self-reflection-*.json`, `gate-failure-*.json`) once they're
  older than `job_log_retention_days` in `config.json` (default 30; a
  missing or invalid value also means 30). Nothing else in `logs/` is
  touched. It logs the day count, cutoff, and files deleted:

  ```
  15 4 * * * cd /var/www/deskmates && node scripts/prune-job-logs.js >> logs/cron.log 2>&1
  ```

- **`run-ideation.js`** (2am) reads `CAPABILITIES.md` plus what's already
  been built/rejected, then runs Claude Code with read-only access to the
  repo and write access scoped to `tasks/pending/` only (verified via
  `--allowedTools`/`--permission-mode dontAsk` — it cannot touch source
  code). It proposes 0–3 ideas; finding nothing worth proposing is a valid,
  logged outcome. Every run is logged to
  `logs/self-ideation-<timestamp>.json`.
- **`run-build-task.js`** (midnight and 3am) works through up to 3 tasks (`MAX_TASKS_PER_RUN`) from
  `tasks/pending/`, oldest first (none pending is a no-op; a failure does not stop the run), implementing each in an isolated
  git worktree (`../deskmates-work-<ts>`, branch `self-edit-<ts>`) with full
  repo access — there's no off-limits file, and no code-review step. The
  change must pass the test gate (see "Test gate" below), which is a hard
  merge gate; it then commits, merges into `main`, restarts
  `deskmates.service`, health-checks it (`systemctl is-active` + an
  HTTP probe), and pushes. Healthy → task moves to `tasks/done/` with the commit hash.
  Unhealthy → `git reset --hard` back to the pre-edit commit, service
  restarted again, task moves to `tasks/failed/` with the failure reason.
  Up to 3 tasks per run (cron: midnight and 3am), no auto-retry — a failure waits for you to
  investigate or re-queue. Every run is logged to
  `logs/self-build-<timestamp>.json`.

### Perpetual cleanup pass

`scripts/run-cleanup.js` (`npm run run-cleanup`) is a recurring, task-less
maintenance job. Suggested cron (not installed automatically):

```
0 5 * * * cd /var/www/deskmates && node scripts/run-cleanup.js >> logs/cron.log 2>&1
```

Each run makes a few small, behavior-preserving improvements (dead code,
needless work, stale docs, UI inefficiencies) in an isolated worktree, then
verifies: the test gate (see "Test gate" below): `node --check` on every JS file, both test suites, a `vite build` of `webapp/` if it changed, and a boot
smoke test of `server.js`. Failures are fed back to Claude to fix. Not clean → the worktree is discarded, `main` is
untouched, and the diff is saved to `logs/self-cleanup-<ts>.patch`. Clean →
merge to `main`, rebuild the live `webapp/dist` if the web app changed, restart + health-check (reset on failure), `git push`. Only our own tracked code is analyzed — never `node_modules` or third-party libraries.
Every run, including "nothing to change", is logged to
`logs/self-cleanup-<ts>.json`; the last five runs' reports are fed into the
next run's prompt so passes build on each other.

`run-build-task.js` restarts the service via `sudo systemctl restart
deskmates.service`, so the user cron runs under needs a passwordless sudo
rule scoped to exactly that command.

## Test gate

Every process that builds or changes code goes through one shared gate
(`scripts/lib/gate.js`; full spec in `TESTING-GATE.md`). Nothing merges or
pushes without passing it.

- Two offline suites (`node:test`, no network or API keys): `tests/green/`
  (valid input behaves as documented) and `tests/adversarial/` (hostile or
  malformed input fails safely). `npm test` runs both.
- A change touching `src/`, `server.js` or `scripts/` must add or modify tests
  in **both** suites (cleanup passes are exempt from this), and every added
  line under `src/` or `scripts/lib/` must be executed by them (Node coverage).
  Removing or skipping tests is never looped on: the change is discarded and
  logged for human review.
- Failures are fed back to Claude until clean. If the same failure shows up in
  3 separate rounds (e.g. fixing adversarial re-breaks green), or 8 rounds pass,
  the change is discarded: nothing is merged or pushed, the task moves to
  `tasks/failed/`, and `logs/gate-failure-<ts>.json` records every round.
- A clean run stamps the code (`.git/gate-pass/`). The hooks in `.githooks/`
  (`npm run install-hooks` sets `core.hooksPath`) refuse any merge or push of
  code without a stamp, including manual ones. Run `npm run gate` on a committed
  checkout to run the gate and stamp it yourself.
- Jobs that only write data (ideation task files, reflection insights, the
  approve/reject scripts) validate what they write (`src/dataValidation.js`).

## Operations

- **Logs:** `journalctl -u deskmates -f` — every connection open/close, auth
  rejection, and `get_canned`/`speech_request` is logged with per-stage
  timing (STT/LLM/TTS).
- **Connection cap:** `config.json`'s `max_connections` (default 4) limits
  simultaneous WebSockets — the physical bot, `/console`, and phone webapp
  sessions share it. It exists because this is a small VPS and each open
  connection holds a session-memory array and, mid-turn, live STT/LLM/TTS
  calls. Clients past the cap get a 503 whose body says
  `at connection cap (n/max)`. Raise it deliberately, not by guess.
- **Restart:** `sudo systemctl restart deskmates`
- **Config reload:** none needed for `config.json` — see above. Code changes
  (`server.js`, anything under `src/`) do need a restart.
- **TLS renewal:** handled automatically by certbot's systemd timer; no
  action needed unless it starts failing (check
  `sudo certbot certificates` and `sudo systemctl status certbot.timer`).

