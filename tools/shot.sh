#!/bin/bash
# Headless-Chrome screenshot of the app at phone size.
# usage: tools/shot.sh "<path and query, e.g. ?play=1&shot=idle  or  tools/demo.html?x=1>" out.png [width height] [wait_ms]
# Starts its own throwaway static server on a random port, shoots, then cleans up.
#
# Headless Chrome refuses to lay a window out narrower than 500 CSS px and its window height
# includes invisible browser chrome, so the page is loaded inside tools/frame.html (an iframe of
# exactly width x height) in a larger window and the PNG is cropped to that frame afterwards.
# The output is therefore a true width x height viewport at 3x.
#
# SHOT_LOG=<file> also saves the page's console output (and uncaught errors) to that file:
#   SHOT_LOG=/tmp/x.log tools/shot.sh "?play=1&shot=idle" /tmp/x.png && grep CONSOLE /tmp/x.log
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
OUT="${2:-/tmp/pumal-shot.png}"
W="${3:-390}"
H="${4:-844}"
WAIT="${5:-3500}"
SCALE=3
PORT=$(( 20000 + RANDOM % 20000 ))
PROF="$(mktemp -d /tmp/pumal-chrome.XXXXXX)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

WINW=$(( W > 500 ? W : 500 ))
WINH=$(( H + 200 ))
SRC="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TARGET")"
URL="http://127.0.0.1:$PORT/tools/frame.html?w=$W&h=$H&src=$SRC"

( cd "$ROOT" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SRV=$!
sleep 0.7
rm -f "$OUT"
RAW="$PROF/raw.png"
LOG="${SHOT_LOG:-/dev/null}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --window-size="$WINW,$WINH" --force-device-scale-factor=$SCALE --virtual-time-budget="$WAIT" \
  --enable-logging=stderr --log-level=0 \
  --user-data-dir="$PROF" --screenshot="$RAW" "$URL" >/dev/null 2>"$LOG" &
CH=$!
# Chrome's new headless mode often lingers after writing the file, so poll and kill.
for _ in $(seq 1 60); do
  [ -s "$RAW" ] && break
  sleep 0.5
done
sleep 0.3
kill "$CH" 2>/dev/null
pkill -f "$PROF" 2>/dev/null
kill "$SRV" 2>/dev/null
if [ -s "$RAW" ]; then
  python3 - "$RAW" "$OUT" "$W" "$H" "$SCALE" <<'PY'
import sys
from PIL import Image
raw, out, w, h, s = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
im = Image.open(raw)
if im.width < w * s or im.height < h * s:
    sys.stderr.write(f"warning: captured {im.width}x{im.height}, smaller than {w * s}x{h * s}\n")
im.crop((0, 0, min(im.width, w * s), min(im.height, h * s))).save(out)
PY
fi
rm -rf "$PROF"
if [ -s "$OUT" ]; then echo "saved $OUT"; else echo "FAILED: no screenshot" >&2; exit 1; fi
