# Deskmates firmware: live debug loop

Goal: the operator interacts with the bot; the agent (or you) watches the logs, finds bugs, fixes them,
adds logging where the cause is unclear, flashes, and repeats until the operator is happy. It is meant to
run hands-off for long stretches, so keep going rather than waiting for a prompt after every step.

## Setup
- Firmware: ESP-IDF 5.5.3 (`~/esp/esp-idf`), ESP32-S3, 16 MB flash. Serial port: `/dev/cu.usbserial-110`,
  console UART at 115200. ELF: `build/ButterBot-Firmware.elf`. Companion mode docs: `COMPANION_MODE.md`.
- `tools/start-logs.sh` starts (if not already running) both log feeds, all lines prefixed with local
  time `HH:MM:SS.mmm`, so the two files share a clock:
  - `tools/logger.py` owns the serial port and appends to `bot.log`. Reopens the port on its own if it drops.
  - `tools/serverlog.sh` streams the server's journal (`ssh $BB_SSH`,
    `journalctl -u $BB_SERVICE -f`) into `server.log`. Reconnects on its own. Node's lines also
    carry their own UTC ISO timestamp; use the local prefix to line up with `bot.log`.
- Never open the serial port yourself (no `idf.py monitor`): the logger owns it.
- `tools/flash.sh` = source IDF env, build, wait for the bot to be quiet, `app-flash`, restart the
  logger (also on failure), print `READY`.
- `tools/mark.sh "text"` adds a `TEST:` marker to `bot.log`. the operator uses it to say what he just did.
- The server source is the Deskmates backend at the repository root, not this directory. Changing or
  restarting the server needs the operator's OK.

## The loop
1. Watch with Monitor: `tail -F bot.log server.log | grep --line-buffered -E "Guru Meditation|abort\(\)|assert|Backtrace|rst:|Brownout|E \(|W \(|task_wdt|panic|[Tt]imeout|TIMEOUT|Turn failed|speech_error|pipeline_error|TEST:"`
   Widen the filter if the bug is behavioral rather than a crash.
2. When the operator reports a problem or a failure shows in the log, find the cause.
   - Crash: decode with `xtensa-esp32s3-elf-addr2line -pfiaC -e build/ButterBot-Firmware.elf <addrs>`.
   - Behavior/timing: reconstruct the timeline from both logs around the nearest `TEST:` marker.
3. If the cause is clear, fix it. If it isn't, **add targeted logging** (see below) and flash so the
   next attempt shows it. If the right behavior is ambiguous, ask the operator before changing code.
4. `tools/flash.sh`. It builds first and waits for a quiet log before resetting the bot, so it won't
   cut off an interaction in progress. When it prints `READY`, tell the operator the bot is ready to test
   (one short line: what you changed and what to try).
5. The operator interacts, logs populate, repeat.

## Known issue to chase first
After several turns the bot "breaks down". Example: asked to summarize unread emails, long pause,
then failure. What the code actually does today:
- `ConverseState::TurnTimeoutMs = 20000` (`main/src/States/ConverseState.h`), counted from the end of
  the utterance upload. A tool-using turn (STT + Claude + email lookups + TTS) can plausibly exceed
  20s. **Prime suspect.** Log which phase the server is in when the bot gives up.
- `ErrorGraceMs = 3000` only applies after the server sends `speech_error` (wait for the pushed
  `pipeline_error` line). Not a slow-turn timeout.
- WebSocket: `network_timeout_ms = 10000`, `ping_interval_sec = 20`, server pings every 25s,
  watchdog restarts the socket after 15s unreachable (`main/src/Net/NetService.cpp`, `NetConfig.h`).
Other suspects:
- A server-side limit on the Claude/tool-use loop or an HTTP client, or nothing sent to the bot
  during a long tool turn. Consider an interim progress/keepalive message and a longer deadline
  for tool turns, extended by server progress messages.
- Resource growth across turns: heap/PSRAM leak on the bot, ever-growing conversation history
  sent to Claude on the server, or WS buffers not freed. Log free heap at each turn.
- A response too long for the bot's buffer (`Dropping oversized ... frame`), or ElevenLabs rejecting
  very long text.

## Diagnostic logging to add (keep it, it's cheap)
Per turn, with a turn id and a millisecond timestamp: VAD end, utterance bytes, WS send done,
`speech_result` header received, binary frame received, playback start/end, and
`esp_get_free_heap_size()` and `heap_caps_get_free_size(MALLOC_CAP_SPIRAM)`. On the server: STT done,
Claude request start/end (and each tool call), TTS first byte/end, total. Make every timeout log what
it was waiting for and for how long. Overlaps `docs/companion-mode-latency-plan.md` (turn timestamps):
build on that plan rather than adding a second scheme.

## Rules
- Work on a branch (`debug/<date>`, cut from the main branch), one commit per attempt, message says
  what failed and why.
- Keep `PROGRESS.md`: per attempt, what was seen, what you changed, result. Keep it short.
- After 5 failed attempts at the same issue: stop, write up findings in PROGRESS.md, and ask.
- Do NOT touch without asking: `partitions.csv`, `sdkconfig` flash/partition settings, anything that
  erases flash or NVS (`erase-flash`; `idf.py fullclean` is fine), the server's `.env`, the model partitions.
- Never print or commit secrets (tokens, API keys, WiFi credentials, SSH passwords).
  `main/src/Net/Secrets.h` is gitignored: never print it; to see its fields, show names only.
- No flash backup exists (a full read kept failing over this USB-serial link; the operator chose to skip it).
  Only ever `app-flash`: it rewrites the app partition and leaves NVS (WiFi, BLE bonds) and the model
  partitions alone. Stock firmware can be restored from the release `.bin` (see README).
- The serial link is flaky at high baud: 921600 fails, 460800 corrupted a long read. Treat a flash that
  dies mid-way as a likely cable/power problem, not a code problem.
- If flashing fails repeatedly or the serial port is wedged, restart the logger once, then stop and
  tell the operator. Don't loop on hardware faults.
- Server-side changes (Node) can be tested with a mock bot client first; only flash when the
  firmware changed.
