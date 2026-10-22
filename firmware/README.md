# Deskmates firmware (ButterBot companion mode)

ESP32-S3 firmware that lets a CircuitMess ButterBot desk robot talk to the Deskmates
server. It is a fork of CircuitMess's open-source
[ButterBot-Firmware-Public](https://github.com/CircuitMess/ButterBot-Firmware-Public)
(MIT, see [LICENSE.md](LICENSE.md)) with a "companion mode" added on top. With companion
mode off, the robot behaves like stock.

> Not affiliated with or endorsed by CircuitMess, Geek Club or Warner Bros. Discovery.
> "ButterBot" is CircuitMess's product name and appears in the upstream code.

## What companion mode adds

- **Server link.** Joins home Wi-Fi (known networks tried in order, with a phone hotspot
  fallback) and keeps a token-authenticated WebSocket open to the Deskmates server.
- **Live conversation.** Stock command listening runs first (dance, dice, IR and so on).
  Unmatched speech streams to the server while you talk, and the server's 16 kHz PCM reply
  plays straight through the speaker. A filler line covers slow replies and tool lookups,
  and the robot falls back to a canned line if the server can't be reached.
- **Wake phrase.** A custom "Hey Gatsby" phrase using the stock on-device speech
  recognition, followed by a short follow-up listening window.
- **Built-in lines.** Startup and goodbye lines are baked into the firmware, so they play
  even before the network is up.
- **Turn toward the speaker (experimental).** Two-microphone direction-of-arrival
  prototype. The tuning history, including what did not work, is in
  [PROGRESS.md](PROGRESS.md).
- **Robot commands from the server.** The server can ask the robot to run a built-in
  routine, such as searching for a person, and gets the result back.
- **Edge safety.** Moving routines stop when the floor sensor loses the surface, so
  the robot halts at a table edge or when picked up. Movement commands take a distance
  or angle and report why they stopped (done, obstacle or edge), so the character can
  explain it.
- **Memory-constrained build.** Built with `-Os`, TLS using software crypto to spare
  internal RAM, and PSRAM-backed allocations. The app partition is nearly full.

Details and design decisions: [COMPANION_MODE.md](COMPANION_MODE.md). Latency work:
[docs/companion-mode-latency-plan.md](docs/companion-mode-latency-plan.md). The live
debug workflow (serial and server logs side by side): [docs/DEBUG-LOOP.md](docs/DEBUG-LOOP.md).

## Setup

1. `cp main/src/Net/Secrets.example.h main/src/Net/Secrets.h`
2. Fill in your Wi-Fi networks, the server URI and the shared token. The token must match
   `BOT_AUTH_TOKEN` in the Deskmates server's `.env`. `Secrets.h` is gitignored.
3. Build and flash as described below. Without `Secrets.h`, companion mode is compiled out.

Helper scripts live in [tools/](tools): `flash.sh` (build, wait for a quiet log, app-flash),
`logger.py` (serial capture), `serverlog.sh` (needs `BB_SSH`) and `mark.sh` (test markers).

## Upstream build notes (from CircuitMess)

## Building

To build the ButterBot firmware, you'll need the ESP-IDF. You can find the getting started
guide [here](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/get-started/).
The production firmware is built using IDF version 5.5.3.

All required components are contained in the repository, and managed components (esp-sr,
esp-dl, esp-tflite-micro, face detection and recognition models, etc.) are fetched
automatically by the IDF component manager during the build.

In the root directory of the project:

**To build the firmware** run ```idf.py build```

**To upload the firmware to the device** run ```idf.py -p <PORT> flash```. Replace `<PORT>` with
the port the robot is attached to, for ex. ```COM6``` or ```/dev/ttyACM0```.

Flashing also uploads the data partitions: the SPIFFS filesystem image built from
[spiffs](spiffs), the object detection model from [models](models), and the speech
recognition and face detection / recognition models provided by the managed components.

## Restoring the stock firmware

To restore the stock firmware, you can download the prebuilt binary on
the [releases page](https://github.com/CircuitMess/ButterBot-Firmware-Public/releases) of
this repository and flash it manually using esptool:

```shell
esptool -c esp32s3 -b 921600 -p <PORT> write_flash 0 ButterBot-Firmware.bin
```

Alternatively, you can also do so using [CircuitBlocks](https://code.circuitmess.com/) by
logging in, clicking the "Restore Firmware" button in the top-right corner, and following the
on-screen instructions.
