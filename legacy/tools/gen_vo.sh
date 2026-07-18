#!/bin/bash
# Generate Gemini-TTS narration wavs from the request bodies written by
# `render_gemini_master.py bodies`. The TrueFoundry API key is loaded from
# .env.local and only ever passed via the Authorization header -- it is never
# echoed, logged, or written to disk.
set -uo pipefail

ROOT=/Users/khoilam/Documents/Crossover/30mpc-website-design-cursor
set -a; . "$ROOT/.env.local"; set +a

# Dirs default to the Round-01 locations; override with VO_BODIES / VO_OUT to
# generate a different round's narration without clobbering another round's wavs.
BODIES="${VO_BODIES:-/tmp/qz_vo/bodies}"
OUT="${VO_OUT:-/tmp/qz_vo}"
FP=/opt/homebrew/bin/ffprobe
mkdir -p "$OUT"

fail=0
for f in "$BODIES"/*.json; do
  name=$(basename "$f" .json)
  code=$(curl -s -o "$OUT/$name.wav" -w "%{http_code}" \
    "$TFY_BASE_URL/audio/speech" \
    -H "Authorization: Bearer $TFY_API_KEY" \
    -H "Content-Type: application/json" \
    -d @"$f")
  mime=$(file -b --mime-type "$OUT/$name.wav" 2>/dev/null)
  dur=$("$FP" -v error -show_entries format=duration \
        -of default=nw=1:nk=1 "$OUT/$name.wav" 2>/dev/null)
  printf "%-10s HTTP %s | %-12s | %ss\n" "$name" "$code" "$mime" "${dur:-NA}"
  if [ "$code" != "200" ] || [ "$mime" != "audio/x-wav" ]; then
    fail=1
    echo "  !! error body (key redacted): $(head -c 200 "$OUT/$name.wav")"
  fi
done

[ $fail -eq 0 ] && echo "gen_vo: all narration clips OK" || echo "gen_vo: FAILURES above"
exit $fail
