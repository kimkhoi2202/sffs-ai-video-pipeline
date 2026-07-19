# Round 01 — Timeline & Voiceover Map

Master: `video/renders/round-01-master.mp4` — "Smart Fella or Fart Smella?" (Kid Loop pilot, variant (a)/(b) mix, lean tier).

- **Resolution:** 1920x1080 (h264, 30 fps)
- **Duration:** 95.57s  ·  **Size:** 4.8 MB  ·  Audio: AAC 48k stereo
- **Placeholder narration:** macOS `say` voice **Samantha** (rate 178). Replace per-segment with the ElevenLabs host VO; the Suno music bed muxes under the whole timeline.

Each segment was rendered as a self-contained clip and concatenated (concat demuxer, stream copy). Times below are absolute positions in the master; drop the ElevenLabs clip for each segment at its **start**, and (for question segments) keep the countdown window fixed so the on-screen 5→0 timer and ticks stay in sync.

| # | Segment | Start | End | Dur | Countdown window | Narration (placeholder = final script line) |
|---|---|---|---|---|---|---|
| 1 | intro | 0:00.00 | 0:09.46 | 9.46s | — | Are you a smart fella... or a fart smella? Let's find out! Three riddles, five seconds each. Get that big brain ready... here we go! |
| 2 | q1 | 0:09.46 | 0:25.82 | 16.36s | 0:20.22 – 0:25.22 | Riddle number one. I have keys, but no locks. A space bar, but nothing to drink. And letters, but I send no mail. What am I? Your five seconds start now! |
| 3 | r1 | 0:25.82 | 0:34.91 | 9.10s | — | Time's up! The answer is... a keyboard! Keys, a space bar, and letters, just not the everyday kind. Did you get it? |
| 4 | q2 | 0:34.91 | 0:50.93 | 16.01s | 0:45.33 – 0:50.33 | Riddle two, and this one is out of this world. Which planet is the hottest in our whole solar system? Is it Mercury, Venus, Mars, or Jupiter? The clock is ticking! |
| 5 | r2 | 0:50.93 | 0:59.21 | 8.29s | — | The answer is... Venus! Its thick clouds trap heat like a cozy blanket, making it even hotter than Mercury. Boom! |
| 6 | q3 | 0:59.21 | 1:13.34 | 14.13s | 1:07.74 – 1:12.74 | Last one, and it's a tricky one. The more you take away from me, the bigger I get. What in the world am I? Five seconds... go! |
| 7 | r3 | 1:13.34 | 1:20.72 | 7.38s | — | Time! The answer is... a hole! The more you dig out of it, the bigger it gets. Sneaky, right? |
| 8 | outro | 1:20.72 | 1:35.48 | 14.76s | — | So, how did you do? Smart fella, or fart smella? Want your official brain score? Grown-ups, pop your email in to unlock the results, and play for a chance at some seriously cool prizes. See you next time! |

## Music (Suno) cue sheet
- **0:00–intro end:** upbeat game-show sting / bright bed, energetic.
- **Question segments:** tension bed under narration; light rise during each countdown window.
- **Reveal segments:** short positive resolve on the 'ding'.
- **Outro:** warm, friendly button; leave headroom for the parent-email CTA line.
- Keep music ~ -18 LUFS under VO; duck ~6 dB during narration.

## SFX baked into this master (placeholders)
- Countdown **tick** (lavfi sine 1400 Hz, ~50 ms) on each of the 5 seconds, low under VO.
- Reveal / intro / outro **ding** (lavfi 880+1320 Hz bell) on the reveal pop.
- Replace with designed SFX at mux time if desired; timings match the countdown windows above.

## Compliance (COPPA / CARU)
- Outro CTA is a **parent action**: “ASK A GROWN-UP TO ENTER THEIR EMAIL TO UNLOCK YOUR SCORE.” No child data requested on-screen.
- Prize tease is parent-facing ($500 input / $2,000 spotlight) with “see official rules · no purchase necessary.”
- No Alpha School / Alpha AI branding anywhere. Neutral “Closer”/Smart Fella visual system only.
