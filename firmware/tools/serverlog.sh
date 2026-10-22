#!/usr/bin/env bash
# Stream the server's journal into server.log at the repo root, each line prefixed with the
# local receive time (HH:MM:SS.mmm, same clock as bot.log). Reconnects if SSH drops.
# Node's own lines also carry a UTC ISO timestamp; the local prefix is the join key with bot.log.
# Usage: tools/serverlog.sh   (start in the background via tools/start-logs.sh)
# Env: BB_SSH (required, e.g. user@your-server), BB_SERVICE (default deskmates.service)
set -uo pipefail

SSH_TARGET="${BB_SSH:?set BB_SSH, e.g. user@your-server}"
SERVICE="${BB_SERVICE:-deskmates.service}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/server.log"

stamp() {
  perl -MTime::HiRes=time -MPOSIX=strftime -ne '$|=1; my $t=time; printf "%s.%03d %s", strftime("%H:%M:%S", localtime $t), ($t*1000)%1000, $_'
}

while true; do
  echo "[serverlog] connecting to $SSH_TARGET ($SERVICE)" | stamp >> "$OUT"
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    "$SSH_TARGET" "journalctl -u $SERVICE -f -n 0 -o cat" 2>&1 | stamp >> "$OUT"
  echo "[serverlog] ssh ended (exit ${PIPESTATUS[0]}), reconnecting in 5s" | stamp >> "$OUT"
  sleep 5
done
