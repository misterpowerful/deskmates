# Companion-mode latency: tighten endpointing + add turn timestamps

Created: 2026-10-02
Context: the owner noticed the physical bot feels ~3x slower than the web app for
the same conversation pipeline. Server-side (butterbot repo) STT/LLM/TTS timing
already looks fine and is shared by both channels, so the extra delay is most
likely pre-server, on the firmware side, in the gap between "person stops
talking" and "upload starts."

## Problem

In `main/src/Audio/AudioFrontend.cpp`, `EightBallRoutine.cpp` calls
`setVADParams(VAD_MODE_3, 128, 1000, 1024)` for its own routine, but the
companion-mode conversation path (`ConverseState` / `ListenState` switching
into `Mode::Speech`) never explicitly calls `setVADParams` at all. That means
`vad_min_noise_ms` (the on-device silence duration used to decide "the person
has stopped talking") is left on whatever the esp-sr library default is. The
header comment in `AudioFrontend.h` documents that default as 1000 ms, which
lines up with the ~1.5s gap the owner is seeing in his serial log between "stopped
talking" and the captured transcript appearing.

The library's documented floor for this parameter is 64 ms, so there's room
to tighten it considerably below the current ~1000 ms default.

## Planned work

### 1. Tighten the silence/endpointing threshold for companion mode

- Explicitly set VAD params when entering the companion-mode conversation
  listen state (wherever `AudioFrontend::Mode::Speech` is engaged for
  companion mode specifically — do not change `EightBallRoutine`'s own
  tuning).
- Target `vad_min_noise_ms` around 400-500 ms as a starting point (down from
  the ~1000 ms default), keeping `vad_mode`, `min_speech_ms`, and
  `vad_delay_ms` as currently defaulted unless testing shows they also need
  adjustment.
- 400-500 ms is a starting point, not a final value — low enough to feel
  snappier, high enough to not cut off a person mid-sentence during a normal
  speaking pause. Needs real-world tuning once flashed.
- Watch for false-cutoff regressions (bot responding to a half-finished
  sentence) during testing; back off toward 600-700 ms if that happens
  rather than pushing lower.

### 2. Add timestamped per-turn logging across the conversation handoff

Add explicit `ESP_LOGI` (or equivalent) timestamped log lines at each handoff
point in the companion-mode turn, so a single turn's timing can be read
straight off the serial log instead of inferred:

1. **Speech end / capture stop** — the instant on-device endpointing decides
   the person has stopped talking and capture closes.
2. **Upload start** — right before `NetService::sendSpeech` begins sending
   the header + PCM frame. (Note: `sendSpeech` already logs bytes sent, a
   duration, and RSSI on completion — this new log is the *start* marker so
   elapsed capture-to-upload gap is visible, not a replacement for the
   existing one.)
3. **Server reply received** — the moment the `speech_result` header +
   audio frame lands back over the WebSocket.
4. **Playback start** — the instant the bot begins speaking the real
   (non-filler) response.

Each line should include the turn's `speech_request` id (e.g. `s-101`) so
the four lines for one turn can be grepped/correlated together in the log,
the same way `speech_request %s sent in %lld ms` already does.

### 3. Correlate with server-side timing

No server changes needed — `logs/turns.db` in the `butterbot` repo already
records `ms_stt`, `ms_llm`, `ms_tts`, and `ms_total` per turn. Once the
firmware timestamps above exist, a single turn's full breakdown (on-device
endpointing time, Wi-Fi upload time, server processing time, playback
kickoff) can be assembled by pulling the matching turn id from both logs
side by side.

## Out of scope / not touched

- `EightBallRoutine`'s own `setVADParams` call and tuning — untouched.
- Server-side STT/LLM/TTS pipeline — already instrumented, not the
  suspected bottleneck, no changes planned here.
- Moving to streaming STT (Scribe v2 Realtime) or streaming TTS output —
  bigger architectural change, separate discussion if endpointing +
  logging doesn't close the gap.

## Done when

- [ ] Companion-mode conversation listen state explicitly sets
      `vad_min_noise_ms` (~400-500 ms starting point) instead of relying on
      library default.
- [ ] Four new timestamped log lines added across the turn handoff
      (speech end, upload start, server reply received, playback start),
      each tagged with the turn id.
- [ ] Flashed and tested on real hardware: confirm no false mid-sentence
      cutoffs at the new threshold, and pull one full turn's logs
      (firmware + `turns.db`) to confirm the latency breakdown is now
      readable end-to-end.
