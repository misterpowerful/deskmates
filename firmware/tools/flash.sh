#!/usr/bin/env bash
# Build -> wait for the bot to go quiet -> app-flash -> restart logger. Works from any directory.
# Usage: tools/flash.sh [port]
# Env: FLASH_BAUD (default 460800; 921600 fails on this adapter, falls back to 115200 on failure),
#      QUIET_SECS (default 15), MAX_WAIT (default 90), NO_WAIT=1 to skip the gate
PORT="${1:-/dev/cu.usbserial-110}"
BAUD="${FLASH_BAUD:-460800}"
QUIET="${QUIET_SECS:-15}"
MAX_WAIT="${MAX_WAIT:-90}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PY="${BB_PY:-$HOME/.espressif/python_env/idf5.5_py3.12_env/bin/python}"

# ESP-IDF environment (export.sh isn't nounset-safe, so source it before set -u)
. "${IDF_PATH:-$HOME/esp/esp-idf}/export.sh" > /dev/null
set -euo pipefail
cd "$ROOT"

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }
start_logger() {
  # Background only the logger itself; backgrounding the whole `pgrep || nohup` list leaves a subshell
  # holding this script's stdout open, so a caller piping our output never sees EOF.
  if ! pgrep -f "tools/logger.py" > /dev/null; then
    nohup "$PY" "$HERE/logger.py" "$PORT" > /dev/null 2>&1 &
  fi
}

# 1. Build first, while the bot is still usable
idf.py build

# 2. Don't reset the bot mid-interaction: wait until the log has been quiet for QUIET seconds
if [ "${NO_WAIT:-0}" != "1" ] && [ -f bot.log ]; then
  waited=0
  while [ $(( $(date +%s) - $(mtime bot.log) )) -lt "$QUIET" ] && [ "$waited" -lt "$MAX_WAIT" ]; do
    sleep 2; waited=$((waited + 2))
  done
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    echo "note: log never went quiet for ${QUIET}s, flashing after ${MAX_WAIT}s"
  fi
fi

# 3. Release the serial port (only one process can own it), then flash only the app.
#    The trap restarts the logger even if flashing fails, so the log never goes dark.
trap start_logger EXIT
pkill -f "tools/logger.py" 2>/dev/null || true
sleep 0.5
if ! idf.py -p "$PORT" -b "$BAUD" app-flash; then
  echo "app-flash at $BAUD failed, retrying at 115200"
  idf.py -p "$PORT" -b 115200 app-flash
fi

# 4. Restart the logger right away so boot output is captured
"$HERE/mark.sh" "--- flashed ---"
start_logger
trap - EXIT
echo "READY: flashed at $(date +%H:%M:%S). Logger running."
