#!/usr/bin/env bash
# Start the serial logger and the server log stream if they aren't already running.
# Usage: tools/start-logs.sh [port]
set -euo pipefail

PORT="${1:-/dev/cu.usbserial-110}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${BB_PY:-$HOME/.espressif/python_env/idf5.5_py3.12_env/bin/python}"  # has pyserial

if pgrep -f "tools/logger.py" > /dev/null; then
  echo "logger: already running"
else
  nohup "$PY" "$HERE/logger.py" "$PORT" > /dev/null 2>&1 &
  echo "logger: started on $PORT"
fi

if pgrep -f "tools/serverlog.sh" > /dev/null; then
  echo "serverlog: already running"
else
  nohup "$HERE/serverlog.sh" > /dev/null 2>&1 &
  echo "serverlog: started"
fi
