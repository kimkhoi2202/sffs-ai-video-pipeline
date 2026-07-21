# renders.nosync/ layout

All render **media** (mp4 / png / wav) lives under `renders.nosync/` on purpose:
the `.nosync` suffix makes iCloud skip the whole tree, so heavy files never
throttle file I/O. Media is git-ignored; the sidecar metadata next to it
(`*.json`, `*.md`, `*.srt`, `*.vtt`, `*.txt`) is tracked. **Never render to the
Desktop** — see `remotion/scripts/render-brand.sh` and the `render:*` npm scripts.

## videos/
- `round-XXX/` — mass-gen quiz rounds (`render-round.ts`): `<platform>/<slug>/` each with `<slug>.mp4` + `captions.srt`/`.vtt` + `info.md` + `questions.json`.
- `instagram/` · `tiktok/` · `youtube/` · `shorts-60/` — the phase-1 cut set (`build-cuts.ts`).
- `intro/` — brand intro (`sffs-brand-intro-v1.mp4`) + `script.txt` (narration). `npm run render:intro`.
- `reply/` — `reply-1.mp4` (current) + `reply-1-prev.mp4` (superseded earlier take). `npm run render:reply`.
- `ready-to-post/` — 5 curated posting packages (`NN-...`), each `video.mp4` + `captions.srt`/`.vtt` + `caption.txt`.

## ../thumbnails/  (sibling of videos/)
- 15 A/B thumbnails: `thumb-{16x9,1x1,9x16}-{blue,coral,cream,green,yellow}.png`. `npm run render:thumbs`.
- `earlier/` — 3 earlier single-variant brand thumbs (`thumb-{16x9,1x1,9x16}.png`).

## ../working/ig-safe-area/  (sibling of videos/)
- Generated IG safe-area proposal/crop PNGs (media, git-ignored). The **scripts** that
  produce them are tracked in `video/analysis/ig-safe-area/`.

> Consolidated from `~/Desktop/sffs-*` on 2026-07-20; see `manifest.json` → `extras`.
