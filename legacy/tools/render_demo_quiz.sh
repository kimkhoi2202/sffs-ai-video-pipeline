#!/bin/bash
# Encode each Pillow-rendered segment into its own H.264 clip, then concat.
# Robust-by-design: per-segment clips (identical encoder settings) + concat
# demuxer copy, instead of one giant filtergraph. Audio is added separately
# by add_audio.sh so a reliably-rendering VIDEO is produced first.
set -euo pipefail

FF=/opt/homebrew/bin/ffmpeg
SEG=/tmp/qz_seg
CLIPS=$SEG/clips
MANIFEST=$SEG/manifest.txt
OUT_SILENT=$SEG/round-01-silent.mp4

mkdir -p "$CLIPS"

# Identical settings for every segment -> concat demuxer copy works cleanly.
ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30
     -profile:v high -level:v 4.2
     -x264-params "keyint=60:min-keyint=60:scenecut=0"
     -color_primaries bt709 -color_trc bt709 -colorspace bt709
     -movflags +faststart)

: > "$SEG/concat_list.txt"

while IFS=$'\t' read -r name kind path dur; do
  [ -z "${name:-}" ] && continue
  out="$CLIPS/$name.mp4"
  echo ">>> encoding $name ($kind, ${dur}s)"
  if [ "$kind" = "static" ]; then
    "$FF" -y -loglevel error -loop 1 -framerate 30 -t "$dur" -i "$path" \
      -vf "format=yuv420p" "${ENC[@]}" "$out"
  else
    "$FF" -y -loglevel error -framerate 30 -i "$path/%05d.png" \
      -vf "format=yuv420p" "${ENC[@]}" "$out"
  fi
  echo "file '$out'" >> "$SEG/concat_list.txt"
done < "$MANIFEST"

echo ">>> concatenating segments (copy)"
"$FF" -y -loglevel error -f concat -safe 0 -i "$SEG/concat_list.txt" \
  -c copy "$OUT_SILENT"

echo ">>> done: $OUT_SILENT"
/opt/homebrew/bin/ffprobe -v error \
  -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,nb_frames \
  -of default=noprint_wrappers=1 "$OUT_SILENT"
