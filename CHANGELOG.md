# Changelog

Hand-curated, human-readable summary of notable changes — newest first.
This is separate from the mobile webapp's "Changes" panel, which lists raw
git commit history; this file is what actually renders in the "Latest
Changes" menu item (`src/changelog.js` parses it, `/api/changelog` serves
it). Not every commit gets an entry here — just the ones worth a plain-
language note. For the full commit-by-commit history, use the "Changes"
panel or `git log`.

## 2026-10-11 — Async task delegation (friendly mode)

- A substantial friendly-mode request ("summarize my unread emails", "add
  this to my calendar") can now be handed off to a background worker
  instead of answered live — a short spoken ack plays immediately, the
  work runs in a headless `claude -p` subprocess (subscription-billed, web
  search/Gmail/Calendar/Drive only, nothing that leaves the house executes
  without sign-off), and the bot plays a chime on completion with no
  unprompted speech.
- Say "delegate this" or "hand this off" to skip straight to delegation, or
  let the model decide on its own via a new `delegate_task` tool; `list_tasks`
  and `get_task_result` surface finished work later, on request.
- Results live in `delegated-tasks/` (gitignored, owner-only — can contain
  email content), swept clean of heard results after a week by default.

## 2026-10-01 — Haiku / Sonnet 5.5 model switcher

- New "Model" dropdown in the ☰ menu switches the conversation model between
  Haiku 4.5 and Sonnet 5.5, live, no restart (same mechanism as the
  personality switcher; stored as `active_llm` in config.json).
- Sonnet 5.5 is only offered with thinking turned down (`between_tools`);
  there is deliberately no "5.5 with thinking" option.
- deep_thoughtful keeps its own model and is not affected by the switch.

## 2026-09-23 — Add "Latest Changes" menu item

- New "Latest Changes" item in the mobile webapp's ☰ menu renders this
  file, newest entry first, so what's changed recently is readable without
  digging through git commits.

## 2026-09-23 — Personality display name field

- Personalities can now define a friendly display name separate from their
  folder name, shown in the personality switcher instead of the raw
  directory slug.

## 2026-09-22 — Transcript/turns text wrapping fix

- Long lines in the Transcript and Turns views now wrap instead of running
  off the edge of the screen.

## 2026-09-22 — GitHub commit-history tool for conversation

- Gatsby can now answer "what changed last night" / "what got pushed this
  week" by reading real commit history from any repo on the account via
  GitHub's API, defaulting to the last 24 hours when no window is given.

## 2026-09-22 — UI changes tracker (Changes panel)

- Added the "Changes" panel to the mobile webapp menu: the bot's own
  recent commits, grouped by day, with overnight commits flagged.

## 2026-09-22 — Serialize turns per connection

- Turns on the same connection are now processed strictly one at a time,
  closing a race where overlapping requests could interleave replies.

## 2026-09-21 — Blank STT transcript short-circuit

- An empty speech-to-text result (silence, noise) now short-circuits
  instead of sending a blank turn through the live pipeline.

## 2026-09-21 — Timeouts for external tool HTTP calls

- GitHub, Gmail and Google Calendar lookups now give up after 10 seconds
  instead of hanging the conversation indefinitely on a slow response.

## 2026-09-21 — Memory file write safety

- Long-term memory writes are now atomic (write-then-rename), keep a
  backup, and dedupe near-identical facts instead of accumulating repeats.

## 2026-09-21 — WebSocket inbound validation

- Inbound WebSocket messages are now size- and field-validated before
  being processed, rejecting malformed or oversized payloads safely.

## 2026-09-21 — Global crash safety net

- Uncaught exceptions and unhandled promise rejections are now caught by a
  process-wide handler that logs context instead of taking the service down
  silently.

## 2026-09-21 — Per-turn mode surfaced in the UI

- The console and webapp now show which mode (friendly, sentry_intruder,
  bump_complaint, deep_thoughtful) actually ran each turn, driving the
  visualizer's palette and a labeled chip for deep_thoughtful replies.
