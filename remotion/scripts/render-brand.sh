#!/usr/bin/env bash
# Render the SFFS brand assets (intro + reply + the 15 thumbnails) IN-PROJECT,
# under video/renders.nosync/ (the ".nosync" suffix makes iCloud skip the tree,
# which is what stops the heavy media from throttling file I/O). These outputs
# used to be typed to ~/Desktop by hand — this script bakes the correct
# in-project paths so future renders NEVER land on the Desktop again.
#
# Usage (from remotion/):  npm run render:brand        # intro + reply + thumbs
#                          npm run render:intro        # just the brand intro
#                          npm run render:reply        # just the reply short
#                          npm run render:thumbs       # just the 15 thumbnails
# Only sets output paths; composition logic (IntroBrand/ReplyBrand/Thumbnails) is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."                    # -> remotion/
RN="../renders.nosync"
ENTRY="src/introcut/entry.tsx"
PORT="${PORT:-7788}"

intro() {
  mkdir -p "$RN/videos/intro"
  npx remotion render "$ENTRY" IntroBrand "$RN/videos/intro/sffs-brand-intro-v1.mp4" --port="$PORT"
}

reply() {
  mkdir -p "$RN/videos/reply"
  npx remotion render "$ENTRY" ReplyBrand "$RN/videos/reply/reply-1.mp4" --port="$PORT"
}

thumbs() {
  mkdir -p "$RN/thumbnails"
  # ratio -> composition (see src/introcut/entry.tsx)
  local comps=("9x16:ThumbV" "1x1:ThumbSq" "16x9:ThumbWide")
  # color name -> brand hex (see src/theme/brand.ts COLORS)
  local colors=("blue:#839aff" "coral:#fd7962" "cream:#f6f4ee" "green:#63c088" "yellow:#fce552")
  for c in "${comps[@]}"; do
    local ratio="${c%%:*}" comp="${c##*:}"
    for col in "${colors[@]}"; do
      local name="${col%%:*}" hex="${col##*:}"
      npx remotion still "$ENTRY" "$comp" "$RN/thumbnails/thumb-${ratio}-${name}.png" \
        --frame=60 --props="{\"bg\":\"${hex}\"}" --port="$PORT"
    done
  done
}

case "${1:-all}" in
  intro) intro ;;
  reply) reply ;;
  thumbs) thumbs ;;
  all) intro; reply; thumbs ;;
  *) echo "usage: $0 [intro|reply|thumbs|all]" >&2; exit 2 ;;
esac
