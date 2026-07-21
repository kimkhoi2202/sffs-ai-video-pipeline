# A/B — dont-narrate — no-options-vo/video-1

- **Test:** dont-narrate — Standard 3Q + reveal + score, selectively drop question/options VO (question still displays). Baseline = existing full-narration shorts.
- **Source round:** round-012 (fresh / un-rendered)
- **Aspect:** 9:16 (1080x1920), cold open, 5s countdown/question
- **Treatment:** readVO=stem, dropReveal=false, dropScore=false, endCard=default, speed=false
- **Duration:** ~1:17 (77s)
- **Music:** final-round-fanfare.mp3 · **SFX set:** short-5
- **File:** `dont-narrate-no-options-vo-video-1.mp4`

## Questions (play order)

| # | Source | Category | Difficulty | Type | Answer |
|---|--------|----------|------------|------|--------|
| 1 | Q1 | verbal | easy | ODD ONE OUT | A · BOAT |
| 2 | Q11 | nonverbal | medium | POSITION | A · BOTTOM-LEFT |
| 3 | Q7 | quantitative | hard | NUMBER SERIES | B · 18 |

## Files
- `dont-narrate-no-options-vo-video-1.mp4` — the video (h264/yuv420p + AAC), ffprobe-verified 1080x1920, 77.08s, A/V drift 0.00s.
- `captions.srt` / `captions.vtt` — spoken transcript (phrase-chunked; reflects the dropped/sped VO).
- `questions.json` — this video's questions + treatment.
