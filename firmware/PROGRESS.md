# Debug loop progress

## 2026-10-09

### Attempt 1: crash on turn 2 (internal RAM exhausted during model load)
- **Seen:** Turn 1 OK ("Hi, Gatsby", server 5.8s, reply 6.0s after upload). Turn 2 aborted while loading
  AFE/MultiNet: `ESP_ERR_NO_MEM` in `phy_track_pll_init` -> `esp_timer_create`, called from
  `esp_phy_enable` <- `btdm_sleep_exit` (BLE controller waking from modem sleep). Internal heap min-ever
  119 B, largest block 3 KB right after AFE create. Internal free before AFE load: 21.7 KB (turn 1) ->
  20.5 KB (turn 2).
- **Why:** every BLE modem-sleep wake re-enables the PHY, which allocates a PLL-track esp_timer from
  internal RAM (`MALLOC_CAP_INTERNAL` only) behind an `ESP_ERROR_CHECK`. AFE load leaves ~0 internal RAM.
- **Changed:** `CONFIG_BT_CTRL_MODEM_SLEEP` off (stock had it on; costs some battery) so the PHY stays up
  and no timer is created per wake. Added `[heap turn ...]` logs at turn start, speech_result, reply
  audio, reply ready, playback done, end, filler cached; timeout log now says how long it waited.
- **Not yet fixed:** AFE load still drops internal RAM to near zero; ~1.2 KB lost per turn. Next: use the
  new logs to find the per-turn loss, then cut AFE's internal RAM use.
- **Hardware:** USB-serial drops on every boot/reset (power sag). Bot needs charging / direct port.
- **Result:** turn-2 crash gone (AFE load min-ever 479-799 B vs 119), but WiFi/TLS now stalls ~10-18s and
  drops the socket: 4 times in 6 min (filler downloads and the turn-2 upload; server never got the audio).
  Never seen on stock BT sleep. Always-awake BLE is starving WiFi airtime under coex. Reverted.

### Attempt 2: keep stock BT sleep, move small mallocs to PSRAM
- **Changed:** `CONFIG_BT_CTRL_MODEM_SLEEP` back on (stock). `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` 1024 -> 256,
  so plain mallocs of 256 B-1 KB go to PSRAM and leave internal RAM for allocations that must be internal
  (esp_timer, DMA, WiFi/BT). Goal: AFE load no longer drives internal RAM to ~0.
- **Also seen:** reply audio downloads at ~36 KB/s (183 KB in 5.0s), barely real time (audio is ~30 KB/s).
  `TurnTimeoutMs` (20s) runs until the whole reply audio is in, so a 20-30s spoken email summary plus tool
  time would time out. Likely the email failure; confirm on an email turn.
- **Result:** partial. +10.5 KB internal at boot, +11 KB at turn start, no per-turn loss (turn start/end
  34.5/34.4 KB). But MultiNet create still dips internal to ~1 KB (transient ~20 KB), and a filler
  download overlapping model load hit 819 B. Turn 3 crashed identically (`phy_track_pll_init` NO_MEM on
  BLE wake). **Email failure reproduced:** server done in 6.0s (gmail_search), reply 737 KB; bot timed out
  at 20.0s mid-download; socket also stalled ~5s into the download (TLS read timeout 10s later).
  RTT to server 127 ms, TCP window 5760 B, 4 dynamic WiFi RX buffers -> ~45 KB/s ceiling (seen 30-36).
  The attempt-1 "BLE starves WiFi" stalls were probably this same stall, not BLE.

### Attempt 3: fix the crash at its source, wait out long replies, widen the TCP window
- **Changed:** (1) `--wrap` IDF's `phy_track_pll_init/deinit` (`main/src/Net/PhyPllTrack.c`): the PLL-track
  esp_timer is created once at the first PHY enable and only started/stopped after, so a BLE wake never
  allocates. (2) Turn deadline: 20s until `speech_result`; after that, fail only if no websocket data for
  10s or 90s total; log rx progress every 64 KB for frames >= 128 KB. (3) `LWIP_TCP_WND_DEFAULT` 5760 ->
  23040, `LWIP_TCP_RECVMBOX_SIZE` 6 -> 16, WiFi dynamic RX buffers 4 -> 16 (PSRAM via TRY_ALLOCATE),
  `RX_BA_WIN` 2 -> 4 (IDF caps it at 2x static RX buffers = 4).
- **Note:** app partition now 0x4de0 (19.9 KB) free.
- **Result:** fixed. 4 turns, no crash (model-load min-ever ~1.05-1.5 KB, same as before, now harmless),
  no stalls. Email summary: gmail_search, 911 KB reply downloaded in 6.9s at ~133 KB/s, ready 13.6s after
  upload, played in full (~29s). Calendar list/create turns 5.9-7.6s. Downloads 125-155 KB/s (was 30-36).
  Internal RAM at turn start/end steady at 34.5/34.6 KB across all turns; boot unchanged (72 KB).

### Open items
- (attempt 4) Truncated reply played as audio: after a mid-frame TLS error (attempt-2 firmware) the client
  handed up a 4268-byte "frame" that was accepted as the 127802-byte reply.
- `tools/flash.sh` rebuilds from scratch every time though a build just finished in another shell.
- Filler prefetch at turn end can overlap the next turn's model load (seen at 819 B min-ever).
- App partition is ~20 KB from full: new features (wake phrase) need space.

### Attempt 4: latency (bot felt ~2s slower than the web app)
- **Seen:** listen start -> upload start was a fixed ~6.5s every turn regardless of speech length (3.0s of
  speech still waited 6.5s): companion turns only ended on MultiNet's 6000 ms no-match timeout. Also VAD
  silence 1000 ms (web app 700), upload ~53 KB/s (16 KB TCP send buffer over 127 ms RTT), and the reply only
  started playing after the whole download.
- **Changed:** end the utterance when VAD goes quiet after >= 300 ms of speech (companion mode only; stock
  MultiNet commands still decided first); `vad_min_noise_ms` 700. Reply audio streams into an
  `AudioStream` and plays while downloading (250 ms prebuffer, silence + rebuffer on underrun, playback
  ended if no data for 10s). Reply frame size checked against `bytes` in speech_result/canned_result, and rx
  reassembly reset on disconnect/error (the truncated-reply bug). `LWIP_TCP_SND_BUF_DEFAULT` 16384 -> 32768.
- **Note:** app partition 0x4170 (16.7 KB) free.
- **Result:** works. Listen start -> upload start now tracks speech length (2.9s for 2.0s of speech,
  was a fixed 6.5s). Upload 95-100 KB/s (was ~53). Reply plays as it streams: simple turn listen start ->
  reply streaming 7.1s (was ~13s); email turn upload -> reply speaking ~6.1s (was 13.6s), 785 KB arrived
  in 6.4s with no underrun. Memory steady (34.5 KB at turn end). `StreamAudio` info logs are filtered
  by main.cpp's per-tag log levels (only warnings show); add the tag next build.
- **Next:** stream the utterance upload while the user is still speaking (needs a server protocol change).

### Attempt 5: "Hey Gatsby" wake phrase, 3s follow-up, volume 25%
- **Changed:** `AudioFrontend::Mode::Wake` (was an abort stub) runs MultiNet spotting quietly (no LED, no
  capture). IdleState loads it with "hey gatsby" (`hd GaTSBm`) / "hi gatsby" (`hi GaTSBm`) whenever no
  routine is active, unloads it before any routine starts (many routines use AudioFrontend), and a
  match starts the normal ListenState. After a real reply, ConverseState enters a follow-up ListenState:
  no intro, abort phrases only (skips the ~1.5s command FST build), back to Idle silently if no speech
  within 3s. Speaker `Volume` 0.5 -> 0.25. `StreamAudio`/`WakeWord` info logs enabled.
- **Note:** app partition 0x3a10 (14.9 KB) free. Full rebuilds keep happening for no source reason, and the
  Mac's file table is near its limit (two Virtualization VMs hold ~240k files): build with `-j 4`.
- **Result:** works after four follow-ups: wake listener now starts as soon as WiFi is up (it slept 5 min:
  IdleState is entered before NetService exists), decides on VAD silence, clears the transcript each time,
  and matches how this mic hears the name (G, EH/AE, N/T, IY: "cGfNm", "cGfN Bm", "GfTSm"...). 3/3 wakes
  on the final build, no false triggers from TV/background speech. Follow-up window carried a 6-turn
  conversation. Connect greeting (server canned "greeting") plays ~2s after the first connect. Filler only
  plays when no reply has started 3s after upload (tool turn: filler at 3.0s, reply at 5.7s, seamless;
  chat turn at 2.9s: no filler).
- **Open:** wake -> ready-to-listen takes ~2.5s (intro SFX + 1.5s command FST build), so early speech is
  cut; one wake ended in a stock command/abort instead of conversation. Listening prompt is still the
  robot synth voice (Gatsby lines need generating on the server). USB/power drops on most boots.

### Attempt 6: Gatsby listening line, warm wake handoff, crash-reboot power fix, space
- **Changed:** 8 Gatsby "listening" lines generated on the server (canned `friendly/listening`), cached on
  the bot and played after a wake instead of beeps + synth prompt. IdleState's wake listener registers the
  stock commands + wake phrases and hands the loaded model to ListenState (no ~2s reload). The "power drops"
  were stock hold-to-boot (`ShutdownService::PowerOff()` if the button isn't held ~1s into boot); skipped
  after panic/SW/WDT resets (flash resets still read as POWERON: press power after flashing).
  `CONFIG_LOG_MAXIMUM_LEVEL` debug -> info freed ~117 KB (app partition now 130 KB free).
- **Result:** wake -> question captured and uploading in 3.0s total, no reload between; 4-turn follow-up
  conversation, memory steady ~35 KB. Filler at 3s fired on 2 of 4 chat turns whose replies came at
  3.2-3.3s: 4s threshold recommended (chat 2.4-3.3s, tool turns 5-7s).
- **Options not taken:** switch flite to the 8 kHz kal voice (~2.5-3 MB freed, worse offline voice).

## 2026-10-10 to 2026-10-13: turn toward the speaker (stopped after 5 attempts)

Two head mics, ~2 in apart, either side of the camera. A custom inter-channel lag (cross-correlation,
sub-sample fit) gives left/right; `TurnToSpeaker` turns 45/90 deg after an utterance.

| Attempt | Change | Result |
|---|---|---|
| fbb8fc0 | 30/60 turns, no stale upright check, fresh audio only | turned wrong way at times; lost face recognition |
| 059042c | ignore motor noise from the previous turn, corr >= 0.85 | not tested alone |
| af0e643 | back to 45/90 turns | "completely the wrong way"; wake-phrase turn added ~2 s latency |
| e2fe067 | no turn before listening (turn during server wait); DOA only near VAD speech | latency fixed; readings stronger but scattered |
| 1c610dd | centre 0, dead zone 0.5, reject lag > 2.5 samples | still wrong-way turns |

Readings from a fixed spot, VAD-gated (2026-10-13):
- his left: +1.65, -0.31 (near front), -4.12 (impossible), +0.65, -1.16
- his right: -1.82, +0.06, -0.21
- corr is 0.99 on nearly every reading, which is suspiciously high for two separate mics 5 cm apart.

Conclusion: the lag doesn't separate left from right reliably; no centre or threshold fixes it.
Suspects, not yet checked:
- the two PDM slots may carry nearly the same signal (heavy PDM low-pass, or one mic on both slots);
- desk/monitor reflections dominate at 5 cm spacing.
Next options: dump a few seconds of raw stereo to check the channels offline; or find the speaker with
the camera instead (small scan with face detection after an utterance); or switch turning off.
The USB cable also pulls loose when he spins 90 deg, which dropped the logs twice.

2026-10-13 result: the owner chose to roll the firmware back to 9a6e6cd (speech was best there). All
direction-finding and turning code removed; it remains in history (8311382..a90eeb4) if the camera
approach is tried later. Last finding: with DC removed, the right side read correctly, but from his
left (especially far away) it still read "right" or "ahead" at times.
