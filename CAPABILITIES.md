# Deskmates capabilities

Living summary of what the bot can currently do — written in plain language,
not code. Updated incrementally by `scripts/run-build-task.js` whenever a
build task adds or changes a capability. `deep_thoughtful` mode reads this
file so the bot can answer "what can you do?"-style questions accurately.

## Personality & modes

The bot's character is fully swappable. Right now there are three
personalities defined (`personalities/gatsby-sardonic/`,
`personalities/chet/` and `personalities/reggie/`); only one is "active" at a time via `config.json`.
Gatsby is a refined, sardonic British desk robot — brief, witty, theatrical.
Switching personalities (or adding a new one) needs no code change and no
restart, just a new folder with a system-prompt file, a voice, and canned
audio. The console's personality list shows how many canned-line categories
each personality actually has (e.g. "reggie (0/N lines)"), and
`npm run check-personality` reports the gaps, so a half-built personality is
visible before switching to it. The server also checks the currently active
personality itself: it logs a prominent (non-fatal) warning naming the
missing canned-response categories at startup, and again right after any
live personality switch, so a half-built personality doesn't fail silently.

Independent of personality, every character supports the same four modes,
chosen per-turn by whatever's driving the bot (camera recognition, a bump
sensor, an explicit trigger phrase):

- **friendly** — normal conversation with a recognized owner/household member.
- **sentry_intruder** — an unrecognized person is in view; tone turns
  calm and unsettling, but never gives real tactical/violent content.
- **bump_complaint** — the bot physically collided with something; a dry,
  put-upon one-liner.
- **deep_thoughtful** — an extended, more considered reply (up to ~10
  sentences instead of the usual one or two), triggered by phrases like
  "think it through," "think hard," "think deeply." ("Look it up" stays on
  the normal path, which has web search and answers in seconds.) This is the one mode
  that runs on a bigger model (Sonnet, vs. Haiku everywhere else). It also
  reads this file for "what can you do" questions; no other mode does
  that, to keep the normal fast path fast.
  Its replies are spoken aloud the same way as every other mode; long
  ones are split into pieces to fit the voice provider's length limit and
  played back as one continuous reply.
  The console shows which mode actually ran each turn: the visualizer uses
  that mode's palette, and deep_thoughtful replies get a labeled chip and
  accent bar in the transcript.
  Once triggered it's sticky for the rest of that conversation — every
  later turn stays on the Sonnet/deep_thoughtful path with no need to
  repeat a trigger phrase — until someone explicitly says something like
  "back to normal" or "that's enough thinking," or the conversation ends.
  An unrecognized person under sentry_intruder can't trigger or stay in
  it no matter what they say; if the owner steps back into frame
  mid-conversation, a still-sticky session picks back up without
  re-triggering.

## Canned responses vs. live conversation

Most of what the bot "says" out loud isn't a live LLM call — it's one of
several hundred pre-recorded audio lines (`personalities/<name>/canned-
responses/`), picked at random (excluding a few recently-played ones) and
played back instantly. These cover things like:

- Hardware module events — inserting/removing the LED, PIR (motion),
  gas, temperature/humidity, and IR modules; gas calibration; missing
  modules.
- Sensor/physical events — falling over, being picked up, shaken,
  ending up upside-down.
- Status — battery low/critical/charging, Wi-Fi/phone connection state,
  camera or motor-board failure, startup/shutdown.
- Face recognition — scanning, recognizing the owner, recognizing a
  stranger, registering/forgetting a face.
- Small interactive bits — jokes, an 8-ball, dice rolls, "pass the
  butter," IR-remote learning ("teach me a command"), LED color/mode
  control, phone music/notification control, simple object recognition
  ("what's this" for a handful of known objects), a dance routine.

Only genuine open-ended conversation (a real question, a request to
elaborate, anything not covered by a canned category) goes through the live
pipeline: speech-to-text (ElevenLabs) → Claude → text-to-speech
(ElevenLabs), so it can actually think instead of just replaying a line.

## Memory

Two kinds, both scoped per-personality (switching personality doesn't leak
memory between characters):

- **Session memory** — the current conversation's recent turns, kept in
  RAM only, gone when the personality changes. Lets the bot handle "make it
  shorter," "what was the second one," etc. For a client that sends a
  stable per-connection session id (currently just the mobile webapp), it
  also survives a brief unexpected disconnect: if that same session
  reconnects within a few minutes, the conversation picks back up instead
  of starting over. A connection with no session id (the physical bot) or
  one that's gone quiet past that window starts fresh.
- **Long-term memory** — genuinely persists across restarts and future
  conversations. Only grows when someone says a trigger phrase ("remember
  that…," "don't forget…," "keep in mind…"); the bot gives an instant
  canned acknowledgment, and in the background a small model condenses
  the moment into one short fact appended to that personality's
  `memory.json`. Every future reply for that personality includes the
  accumulated facts as context. Each fact is also tagged (1–3 short
  freeform words, e.g. "music", "preferences") by that same background
  step.
- **Reflection (deep_thoughtful only)** — once a personality has
  accumulated enough tagged facts on the same theme, a weekly job can
  notice the pattern and write it up as an "insight" (a description of
  what the facts show, never a prediction about what the person wants
  next). Insights are auto-approved on write and become available as
  extra context immediately — no human gate. `npm run reject-insight` can
  still delete a bad one after the fact, and `npm run reject-memory-fact`
  does the same for a bad saved fact — or either can be deleted straight
  from the mobile webapp's Memory panel (see Interfaces below), which is
  how a bad auto-approved insight or an unwanted saved fact actually gets
  noticed in the first place.

## Object learning (task-scoped)

Separate from the two memory stores above — this is visual/object data, not
a freeform fact, so it gets its own per-personality file,
`personalities/<name>/objects.json`, plus a `learned-objects/` folder of
saved reference images, rather than living in `memory.json`. It sits
alongside the fixed canned "what's this" object recognition mentioned
above, but can actually grow over time instead of staying a fixed list.
It only ever runs inside an exploration/learning task the owner explicitly
assigns — never spontaneously mid-conversation, the same "initiative only
inside an assigned task" rule the rest of the self-improvement pipeline
follows. When it does run: a camera snapshot is taken and compared — a
coarse image-hash match for now, not a full embedding model — against
everything already learned for that personality; a close-enough match is
recognized silently, and anything new gets asked about over the live
conversation pipeline ("what is this?") so the reply can be saved as that
object's label for next time. Needs an actual camera/snapshot pipeline to
do anything at all; on a deployment without one yet it degrades to a no-op
rather than erroring.

## External tools (friendly and deep_thoughtful)

Web search, plus three real services below, are available in `friendly`
mode (the recognized-owner case — still on Haiku, still short replies) and
in `deep_thoughtful` mode. `sentry_intruder` and `bump_complaint` never get
tools, regardless of what's asked — an unrecognized person can't get the
bot to read email or touch a repo just by talking to it. Every call is
logged; a failed call comes back as an error the model can react to, not a
crash.

- **GitHub** — full read and write, across every repository on the
  account, not just this one. Can read a file's contents and list which
  repos exist (so "my such-and-such repo" can be resolved without being
  told the exact name) freely. Writing is two-step, not immediate: it can
  propose creating or updating a file — describing the change out loud —
  but nothing is actually written until that's explicitly confirmed on a
  following turn. An unconfirmed proposal only lives for one turn; if the
  next thing said isn't a clear "yes, do it," the proposal is gone and
  would need to be made again. Note: reading a file only works on an exact
  known path — there's no way to enumerate what's inside a GitHub
  directory this way. It can also list recent commit history for any repo
  on the account — message, author, date, and files touched — to answer
  things like "what changed last night" or "what got pushed to
  such-and-such this week", defaulting to the last 24 hours (or a handful
  of the most recent commits) when no window is given, and summarizing
  rather than reading the raw list verbatim when there's a lot of it.
- **Local directory listing and file reading** — separate from GitHub
  above: this bot can list the files and subdirectories actually sitting on
  this server's own disk right now, in its own repo (including anything not
  yet committed or pushed), and also read a file's exact on-disk content —
  both confined to that repo only. This is how "what's in the pending task
  queue," "what's in tasks/done," "what does this personality's memory.json
  say," etc. get answered — no GitHub round trip, and no staleness from
  files this server writes at runtime but never commits. Read-only (no
  writes), cannot see anything outside this repo, and refuses hidden or
  sensitive paths (.env, .git, node_modules, logs) even inside it.
- **Gmail** — read-only (search, read a message) plus exactly one write
  action: marking a message as read. No sending, no deleting, no other
  label changes — those aren't available no matter how they're asked for.
  A search is capped at 10 matches per call; if more actually matched, the
  answer says "at least N" rather than implying the list is exhaustive
  (e.g. counting unread mail).
- **Google Calendar** — listing/summarizing events is unrestricted, though a
  single listing call is capped at a handful of events (soonest first) even
  for a broad time range, so a very wide or "this year"-style range should
  be narrowed if the answer needs to be exhaustive. Creating an event only
  ever happens when explicitly asked for in that same turn — never
  spontaneously, and never just because something in conversation sounds
  like it belongs on a calendar. There is no event-update or event-delete
  capability.

## Async task delegation (friendly mode)

A substantial request — summarize unread email, add something to the
calendar, research a topic — doesn't have to be answered live. In
`friendly` mode only (never `sentry_intruder`/`bump_complaint`, and
deliberately not `deep_thoughtful` either), it can be handed off to a
background worker instead: a short spoken acknowledgment plays right away,
the actual work runs out of band, and nothing more is said about it until
asked. On completion the physical bot plays a chime (same chime for a
success, a failure, or one that needs sign-off); anyone connected through
the webapp or debug console at that moment sees a brief toast instead —
either way, never a spoken announcement, so a finished background task
never interrupts an unrelated conversation. If the bot is disconnected when
a task finishes, its chime is queued and plays once it reconnects — unless
it's waited past the same retention window as the result file itself (or
too many piled up during a long outage), in which case it's dropped rather
than chiming about a now-stale task.

Two ways a task gets created:

- **Explicit**: a transcript that opens with "delegate this" or "hand this
  off" (tolerant of punctuation and minor speech-to-text variants) skips
  the model's judgment entirely — everything said after the phrase becomes
  the task verbatim. A quick Haiku call turns it into a short title, and
  the model is asked only for a one-line in-character acknowledgment, not
  a decision about whether to delegate.
- **Automatic**: for anything else that looks like real, substantial work,
  the model has a `delegate_task` tool it can call on its own judgment.

Each task is run by spawning the `claude` CLI headlessly (`claude -p`) as
its own subprocess — never the Agent SDK, and never billed against
`ANTHROPIC_API_KEY` (that key is stripped from the worker's environment;
see `CLAUDE_CODE_OAUTH_TOKEN` in the README). It gets a capped number of
turns, a hard wall-clock timeout, and a fixed, narrow tool allowlist — web
search/fetch plus read/search/draft-only Gmail, read/create Google
Calendar, and read/create Google Drive. Nothing that leaves the house
(sending an email, spending money) is allowed to actually execute: the
worker prepares it (e.g. a Gmail draft) and flags it as needing the
person's sign-off instead of completing it. At most two workers run at
once — the same Claude subscription is shared with everything else this
server does — anything beyond that queues. A worker that fails for any
reason (timeout, bad output, missing credentials) marks its task "failed"
with a short reason; it never silently falls back to metered API spend.

Results live in `delegated-tasks/t-<id>.json` (gitignored, locked to
owner-only, since this can carry email content), not in the git-tracked
`tasks/` build-queue tree above — that directory is committed and has its
own lifecycle (pending/done/failed/proposed/rejected), which a
runtime-only, permission-locked file would conflict with. Heard results
older than a retention window (a week, by default) are swept away
automatically, at startup and hourly; an unheard one is never deleted no
matter how old.

Hearing back is always something the person asks for, never pushed: the
model has a `list_tasks` tool (titles and statuses only, unheard ones by
default) to answer "what's finished," and a `get_task_result` tool to
speak one task's short summary once it's picked out by name — that marks
it heard. The model is also told how many tasks are sitting unheard on
every `friendly`-mode turn (a bare count, not the titles themselves), so it
knows there's something to mention if asked without being tempted to read
the list out unprompted.

TODO (firmware, out of scope here): if the bot is mid-reply when a task
finishes, the completion chime should be held and played once that reply
is done rather than cutting in — not implemented on the server side.

## Interfaces

- **The physical bot** — connects over a WebSocket, sends recorded audio,
  gets raw PCM audio back.
- **A browser debug console** (`/console`) — the same protocol, plus
  console-only admin actions (listing/switching personalities, a typed-text
  shortcut that skips STT/TTS for fast iteration).
- **A mobile web app** — a phone-friendly client of the same backend,
  hardcoded to `friendly` mode (no camera to distinguish
  friendly/intruder), with its own UI for the same conversation and canned
  lines. It's installable to a phone's home screen as a standalone app
  (a web app manifest plus the iOS/Android "add to home screen" meta
  tags), and a small offline service worker keeps the app shell and the
  most recently loaded conversation viewable with no connection. Reopening
  it also restores that conversation's own history: session turns are
  durably logged server-side, and the app replays them into the Transcript
  on load instead of starting blank. The main screen shows
  just the Visualizer and Transcript; the
  personality switcher, colors, build queue, and log/usage panels sit
  behind a collapsed ☰ menu. A Changes panel there lists the bot's own
  recent commits grouped by day (7/14/30 days), with overnight commits
  flagged, so you can see what code was pushed most recently. A separate
  "Latest Changes" panel renders `CHANGELOG.md` — a hand-curated,
  plain-language changelog committed to the repo — newest entry first, for
  a human-readable "what's changed recently" view that doesn't require
  reading commits at all. A Memory panel there lists the active
  personality's long-term-memory facts and reflection insights (see
  Memory above), newest first with their tags, so either one can be
  reviewed without SSHing in — and deleted directly from there (with a
  confirmation first), with no need to fall back to `npm run reject-insight`
  or `npm run reject-memory-fact` on the server itself. If the connection
  drops unexpectedly (wifi/cell
  handoff, the app backgrounded, a server restart), it reconnects on its
  own with backoff rather than requiring a manual reload; the status pill
  shows "reconnecting" while it retries, and the conversation's session
  memory (see Memory above) picks back up rather than resetting. If a
  spoken turn itself fails
  (speech recognition error, or the live pipeline erroring out) rather than
  getting a reply, that shows up as a visible error line in the Transcript
  and the mic returns to listening right away — not just a silent stop with
  the reason buried in the hidden Log panel. The same applies to tapping the
  mic button itself: if the browser denies/has no microphone to grant, or
  can't record at all, the tap button's hint line says so in plain language
  ("Microphone access is blocked — check your browser settings", "No
  microphone found") instead of silently sitting on "Tap to start talking"
  with no visible sign anything went wrong.

## Self-improvement pipeline (internal/dev, not a conversational topic)

The bot's own codebase can be extended over time without the owner hand-writing
every change. Ideas reach the same `tasks/pending/` build queue by two
separate paths that differ in exactly one important way — whether a human
reviews the idea before it's buildable:

Note: the conversational path below is gated per-personality —
`config.json`'s `self_improve_personalities` list names which active
personalities get it at all (this document included: `getCapabilitiesBlock`
in `src/speechPipeline.js` cuts this whole section out of an unapproved
personality's system prompt, not just the propose_task tool). A personality
not on that list has no context clue this pipeline exists and cannot write
to `tasks/pending/` no matter what's asked of it. The overnight path further
below is unaffected either way — it's a cron job independent of which
personality is currently active, and already requires the owner's explicit
approval regardless.

- **Tasks** (`tasks/`) describe a change in plain language — written by
  The owner, or by the bot itself via either path below. All of them go straight
  into `tasks/pending/`, the build queue.
- **Overnight ideation** (`scripts/run-ideation.js`, daily cron): reads this
  file plus what's already been built, queued, failed, or rejected, and —
  with read-only access to the repo and write access scoped to
  `tasks/pending/` only — proposes a small number of concrete, non-duplicate
  improvements. There is no approval step: they're eligible for the next
  nightly build. `npm run reject-task` (or the trash icon on a card in the
  webapp's build queue panel) moves one to `tasks/rejected/` so it isn't
  re-suggested.
- **Conversational** (`src/speechPipeline.js`, `deep_thoughtful` mode only):
  when someone explicitly asks Gatsby for a self-improvement idea ("how
  could you improve," "any ideas to improve yourself," etc.) and it has a
  genuinely new one — checked against this file and a summary of its own
  past proposals given to it as context — the idea is written straight to
  `tasks/pending/` with `source: gatsby-conversation`, **skipping
  approval entirely**. It's eligible for the very next nightly build with
  no human review in between; `npm run reject-task` (or the webapp's build
  queue panel) works on `tasks/pending/`, so the owner can still pull one
  before that happens. The same context lets Gatsby answer "what have you
  proposed?" from real state, across `tasks/pending/`, `tasks/done/`,
  `tasks/failed/`, and `tasks/rejected/`.
- **Queue on request** (`queue_task` tool, `friendly` and `deep_thoughtful`):
  when someone explicitly asks Gatsby to add or queue a task they've
  described ("add this to the build queue"), it writes their task to
  `tasks/pending/` with `source: gatsby-conversation` and commits it, in the
  same turn — the request is the confirmation. Only personalities in
  `config.json`'s `self_improve_personalities` have the tool at all.
- **`scripts/run-build-task.js`** (daily cron) takes the single oldest
  pending task — from either path — implements it in an isolated git
  worktree, runs tests/lint if present, merges to `main` on success,
  restarts the live service, health-checks it, and rolls back automatically
  if the restart doesn't come up healthy. One task per day, no auto-retry
  on failure.

## Resilience

Brief, self-resolving failures from Claude or ElevenLabs (network hiccups,
momentary service delays, rate limits) are retried up to three times with
increasing waits before the bot gives up and reports an error. Permanent
errors such as bad credentials fail immediately, without retrying.
Lookups against GitHub, Gmail and Google Calendar give up after 10 seconds
instead of hanging, and read-only lookups get the same brief retry. Actions
that change something (saving a GitHub file, marking mail read, creating an
event) are never retried, so nothing gets done twice.

A robot body command (currently just the find-me sweep) gives up after 90
seconds if the robot never reports back — wifi drop, crash mid-sweep, or
the connection simply closing. Rather than leaving the conversation hanging
with no outcome after being told "I'm on my way," the bot hears that
contact with the robot was lost.
