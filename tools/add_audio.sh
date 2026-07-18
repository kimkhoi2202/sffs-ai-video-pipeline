#!/bin/bash
# Add a lightweight synthesized audio bed to the silent master:
#   - soft "tick" on each countdown second (during the 3 question windows)
#   - two-tone "ding" at each of the 3 answer reveals
# All generated with ffmpeg lavfi (aevalsrc). If anything fails, fall back to a
# clean silent AAC track so the deliverable always has a valid audio stream.
# (The real ElevenLabs VO + Suno music get muxed in later.)
set -uo pipefail

FF=/opt/homebrew/bin/ffmpeg
SEG=/tmp/qz_seg
A=$SEG/audio
SILENT=$SEG/round-01-silent.mp4
OUT=/Users/khoilam/Documents/Crossover/30mpc-website-design-cursor/video/renders/round-01-demo.mp4
mkdir -p "$A"

TICK="0.22*sin(2*PI*1150*t)*exp(-32*mod(t,1))"
DING="0.30*sin(2*PI*880*t)*exp(-3.5*t)+0.18*sin(2*PI*1320*t)*exp(-3.5*t)"

set -e
# tick trains sized to each countdown window (ticks at t=0,1,2,... each second)
"$FF" -y -loglevel error -f lavfi -i "aevalsrc=exprs='$TICK':d=7:s=44100"  "$A/ticks_q1.wav"
"$FF" -y -loglevel error -f lavfi -i "aevalsrc=exprs='$TICK':d=8:s=44100"  "$A/ticks_q2.wav"
"$FF" -y -loglevel error -f lavfi -i "aevalsrc=exprs='$TICK':d=10:s=44100" "$A/ticks_q3.wav"
"$FF" -y -loglevel error -f lavfi -i "aevalsrc=exprs='$DING':d=1.6:s=44100" "$A/ding.wav"
set +e

# Place ticks at countdown starts (6s,18s,31s) and dings at reveals (13s,26s,41s)
"$FF" -y -loglevel error -i "$SILENT" \
  -i "$A/ticks_q1.wav" -i "$A/ticks_q2.wav" -i "$A/ticks_q3.wav" \
  -i "$A/ding.wav" -i "$A/ding.wav" -i "$A/ding.wav" \
  -filter_complex "\
[1]adelay=delays=6000:all=1[t1];\
[2]adelay=delays=18000:all=1[t2];\
[3]adelay=delays=31000:all=1[t3];\
[4]adelay=delays=13000:all=1[d1];\
[5]adelay=delays=26000:all=1[d2];\
[6]adelay=delays=41000:all=1[d3];\
[t1][t2][t3][d1][d2][d3]amix=inputs=6:normalize=0:duration=longest[mix];\
[mix]apad[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ac 2 -ar 44100 -shortest "$OUT"
STATUS=$?

if [ $STATUS -ne 0 ] || [ ! -s "$OUT" ]; then
  echo "!!! audio mux failed (status $STATUS); falling back to silent AAC track"
  "$FF" -y -loglevel error -i "$SILENT" -f lavfi -i anullsrc=r=44100:cl=stereo \
    -map 0:v -map 1:a -c:v copy -c:a aac -b:a 128k -shortest "$OUT"
fi

echo ">>> final: $OUT"
/opt/homebrew/bin/ffprobe -v error \
  -show_entries format=duration,size:stream=index,codec_type,codec_name,width,height,channels \
  -of default=noprint_wrappers=1 "$OUT"
