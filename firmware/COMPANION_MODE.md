# Companion Mode (home WiFi + server conversation)

Branch: `companion-mode`. Adds internet access and live conversation with the ButterBot brain
server (`wss://your-server.example.com`) on top of stock firmware. Stock behavior is
unchanged when `Secrets.h` is absent.

**Status: running on hardware.** Ongoing tuning is logged in `PROGRESS.md`.

## Setup

1. `cp main/src/Net/Secrets.example.h main/src/Net/Secrets.h`
2. Fill in `Secrets.h`:
   - `Networks` - home WiFi first, phone hotspot second (tried in order).
   - `BotAuthToken` - must equal `BOT_AUTH_TOKEN` in the server's `.env`.
   `Secrets.h` is gitignored; never commit it.
3. `idf.py build` (first build pulls `espressif/esp_websocket_client` from the component registry)
4. `idf.py -p /dev/ttyACM0 flash monitor`

Restore stock anytime: flash the release `.bin` (see README) or use CircuitBlocks.

## How it behaves

| Situation | Network | Voice |
|---|---|---|
| Idle / Listen / Scenario | Home WiFi or hotspot (DHCP) + WebSocket to server | Live |
| Controller sends `EnterRC` (start driving) | Companion WiFi fully torn down, stock RC WiFi to controller | Off |
| RC ends (BLE or controller WiFi drops) | Companion WiFi + WebSocket come back | Live |

Conversation flow (button press, same as stock listening):
1. Stock `ListenState` runs first - built-in commands (dance, dice, IR, etc.) work exactly as before.
2. If nothing matched, the captured utterance goes to `ConverseState`:
   - no speech heard -> stock "listening timeout" line
   - server unreachable -> hard fallback line ("Well, you've gone and done it. I'm speechless.")
   - otherwise: cached in-character filler starts playing, then `speech_request` + PCM is uploaded;
     real reply is queued to play the moment the filler ends.
3. Server-side failures play the server's pushed `pipeline_error` line if it arrives within 3s,
   else the hard fallback line. Power button / controller Listen / ShutUp aborts.

## Files

- `main/src/Net/NetService.*` - companion WiFi (DHCP, known-network rotation, backoff) and the
  long-lived WebSocket (auth header, session_id, filler cache, speech turns, frame reassembly).
- `main/src/States/ConverseState.*` - one conversation turn.
- `main/src/Audio/PCMPassthroughGenerator.*` - plays server PCM directly (speaker I2S is 16kHz mono 16-bit, same as ElevenLabs `pcm_16000`).
- `main/src/Net/NetConfig.h` - tunables (mode, retries, backoff, size caps).
- Stock touch points: `AudioFrontend` (utterance capture tap), `ListenState` (route unmatched speech),
  `RCState` (suspend/resume companion WiFi), `main.cpp` (start service), `ServiceLocator`.

## Deliberate choices worth knowing

- **Separate from CMF `WiFi`.** Stock `WiFi` hardcodes static `11.0.0.x` addressing and disables
  DHCP (fine for the controller link, useless for a real router). Both it and `NetService` own the
  ESP-IDF default event loop and WiFi driver, so they are never alive at the same time -
  `RCState` suspends companion mode before building its WiFi and resumes after deleting it.
- **`MultinetDuration` raised 4000 -> 6000 ms** so sentences aren't cut off. Recognized commands
  still fire instantly; only the no-match timeout (for all Speech-mode users) is 2s longer.
- **Compiler optimization switched to size (`-Os`).** With IDF 5.5.3 and current managed components even the
  stock app overflowed the 8432K `factory` partition by ~214KB, and every data partition is already full.
  flite and `main/src/Audio/*.cpp` stay at `-O2` (small code, time-critical); esp-sr / esp-dl kernels are
  prebuilt and unaffected.
- **State machine stack raised 4096 -> 6144** in `sdkconfig`: TLS writes for the upload run on that task.
- **Mode is always `friendly`** for now (button press = owner). Sentry/face-recognition wiring is an open item.
- **Hard fallback uses the stock on-device voice** (flite). Swapping in a clip in Gatsby's voice is a later polish item (storage partition has ~60KB free, so it'd need AAC).

## First-flash test checklist

Watch `idf.py monitor` for `NetService` / `ConverseState` logs.

1. Boot: `Got IP ... on '<ssid>'` then `Connected to server` then `Filler cached`.
2. Press button, say a stock command ("dance") - stock behavior, no server call.
3. Press button, say something conversational - filler plays, then Gatsby replies.
   Server log should show `speech_request ok` with the transcript.
4. Press button, say nothing - stock timeout line.
5. Turn off home WiFi - fallback line on the next attempt; turn it back on - reconnects on its own.
6. Start RC from the controller - driving/FPV works as stock. Exit RC - `Connected to server` again.
7. Hotspot: remove home network from range, confirm it falls through to the hotspot entry.

## Likely tuning points on real hardware

- **Internal RAM.** BLE + camera + esp-sr + WiFi + TLS is a lot for internal SRAM. First flash
  aborted with `Mem alloc fail` in the WiFi/BT drivers, so `SPIRAM_MALLOC_ALWAYSINTERNAL` was
  lowered 4096 -> 1024 (plain mallocs > 1KB go to PSRAM) and `SPIRAM_MALLOC_RESERVE_INTERNAL`
  raised 16K -> 48K (held back for drivers that must use internal RAM). `NetService` logs
  `[heap ...]` lines with internal free / largest block / min-ever at boot, got-IP and connect.
  TLS buffers are already in PSRAM (`MBEDTLS_EXTERNAL_MEM_ALLOC`).
- **WiFi throughput.** Stock sdkconfig had 2 WiFi TX/RX buffers and a 5760-byte TCP send buffer,
  tuned for the controller link; the first on-device upload stalled (`transport_poll_write(0)`,
  10s write timeout) with BLE connected. Static TX buffers must stay at 2: they are internal DMA
  RAM (~1.6K each) and 16 of them ran internal RAM out at WiFi start (only ~62K internal is free
  at that point). Raised instead: 16 cache TX (queue slots), 4 dynamic RX, 16K TCP send buffer.
- **Software AES/SHA for TLS.** Hardware AES (and SHA) allocate an internal-RAM DMA bounce buffer
  per TLS record because mbedTLS buffers live in PSRAM. Once ListenState loads the AFE/MultiNet,
  internal RAM drops below 1K and that allocation fails (`esp-aes: Failed to allocate memory`),
  killing the connection mid-read or mid-upload. Software AES needs no internal RAM and is fast
  enough for audio-sized payloads. Hardware MPI (handshake bignum math) is unchanged.
- **Allocation failures no longer abort.** Stock had `HEAP_ABORT_WHEN_ALLOCATION_FAILS=y`, which
  turns the WiFi/BT drivers' normally-recoverable allocation misses (dropped packet) into a reboot.
- **Upload size.** The captured utterance is trimmed to the VAD speech span +/- 300ms before
  sending, instead of the whole listening window.
- **Reconnect.** esp_websocket_client stops for good after some server-initiated closes (the
  server `terminate()`s a socket that misses a 25s heartbeat), so `enable_close_reconnect` is on,
  and a 5s watchdog in `NetService` rebuilds the websocket if WiFi is up but the server has been
  unreachable for 15s (`NetConfig::WsWatchdog*`).
- **Logging.** Stock sets every log tag to WARN; `NetService` and `ConverseState` are raised back
  to INFO in `main.cpp` so connection and turn progress show in the monitor.
- **Capture quality.** Audio is the AFE output with AGC. If STT struggles, check levels in the server log / debug console.
- **Timings.** `ConverseState::TurnTimeoutMs` (20s, counted from the end of the upload), `ErrorGraceMs` (3s), `NetConfig` backoffs.
