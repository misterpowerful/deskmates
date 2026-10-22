#!/usr/bin/env bash
# Drop a marker into the log so Claude can line up what you did with what the bot printed.
# Usage: tools/mark.sh "said 'hello', no response"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(perl -MTime::HiRes=time -MPOSIX=strftime -e '$t=time; printf "%s.%03d", strftime("%H:%M:%S", localtime $t), ($t*1000)%1000')"
echo "$TS TEST: $*" >> "$ROOT/bot.log"
