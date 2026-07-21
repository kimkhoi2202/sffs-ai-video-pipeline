# A/B — mascot — video-1

- **Test:** mascot — Standard cold-open 3Q + reveal + score (5s countdowns, distinct music+SFX) WITH a bottom-right talking-brain narrator lip-synced to every VO clip across the whole video. Baseline = the existing full shorts (no narrator).
- **Source round:** round-023 (fresh / un-rendered)
- **Aspect:** 9:16 (1080x1920), cold open, 5s countdown/question
- **Narrator:** bottom-right talking brain-mascot (vector), lip-synced to every VO clip (question-read → time's-up → reveal → score → outro), idling at rest during VO-silent gaps. Rhubarb visemes from the EXACT muxed audio; per-clip local time with the calibrated AAC-priming offset (2048/48000 s).
- **Treatment:** standard cold-open 3Q + reveal + score (baseline + narrator overlay)
- **Duration:** ~1:40 (100s)
- **Music:** gameshow-fanfare.mp3 · **SFX set:** short-1
- **File:** `mascot-video-1.mp4`

## Questions (play order)

| # | Source | Category | Difficulty | Type | Answer |
|---|--------|----------|------------|------|--------|
| 1 | Q1 | verbal | easy | ODD ONE OUT | A · SNOW |
| 2 | Q11 | nonverbal | medium | POSITION | D · BOTTOM |
| 3 | Q7 | quantitative | hard | NUMBER SERIES | A · 45 |

## Files
- `mascot-video-1.mp4` — the video (h264/yuv420p + AAC), ffprobe-verified 1080x1920, 100.52s, A/V drift 0.00s.
- `captions.srt` / `captions.vtt` — spoken transcript (phrase-chunked).
- `questions.json` — this video's questions + treatment.
