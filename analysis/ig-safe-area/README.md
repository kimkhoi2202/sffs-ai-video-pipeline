# IG safe-area analysis

Working tooling that measured Instagram Reels' UI chrome and proposed the
9:16 safe-area insets used by the brand intro/reply compositions.

- `analyze_safe_area.py`, `analyze_v2.py` — measure chrome from a screenshot; write `measurements.json` (here, git-tracked).
- `draw_safe_area.py`, `draw_v2.py`, `draw_safe_area_v3.py` — draw the proposal overlays.
- `measurements.json` — measured boundaries (small, tracked).

**Generated PNGs (proposal overlays + crop) render IN-PROJECT to**
`../../renders.nosync/working/ig-safe-area/` — under `.nosync` so iCloud skips
the media, and git-ignored (like every other render). They are **not** written to
the Desktop anymore. Re-run e.g. `python3 draw_safe_area_v3.py`.

Consolidated from `~/Desktop/sffs-intro/` on 2026-07-20.
