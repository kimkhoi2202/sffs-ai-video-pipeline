# Kid Loop — Video Production System

The complete system for producing **original** neo-brutalist ("Closer" brand) riddle/quiz videos —
the marketing **"Kid Loop"** — from a puzzle idea to a published long-form video plus its Shorts,
carousel, and blog cuts, all funneling to a **COPPA-safe parent-email capture**.

> **North star:** every video is an audience-building funnel whose one job is to move a kid to a
> results gate that captures a **parent's email** — **never** the child's data. Compliance is a hard
> gate, not a nice-to-have.

---

## The pipeline (build & render)

This repo is the **self-contained AI video pipeline** for the "Smart Fella or Fart Smella" (SFFS)
CogAT quiz video. It has three moving parts plus the committed assets/audio needed to render:

| Folder | What it is |
|---|---|
| [`remotion/`](remotion/) | **Remotion (React) video project** — the current renderer. `src/` has the compositions, scenes, components, theme, and data; `public/` holds the audio (SFX, narration, music), fonts, and images the render reads via `staticFile`. |
| [`voice/`](voice/) | **ElevenLabs voice / narration pipeline** (Python). Designs + clones the game-show host voice and generates per-beat narration mp3s, SFX, and captions. Superseded takes are archived under [`voice/_backups/`](voice/_backups/). |
| [`assets/`](assets/) | Source music (mp3/wav), title cards, and the SFFS logo. |
| [`renders/`](renders/) | Output `.mp4` masters (git-ignored — big + regenerable). The published cuts are organized under [`renders/videos/`](renders/videos/) — one folder per video (mp4 + `captions.srt`/`.vtt` + `questions.json` + `info.md`), with a top-level `manifest.json`. |
| [`legacy/`](legacy/) | **Superseded** Python + ffmpeg render pipeline — `legacy/tools/` (the old `render_cogat_round_*.py` / `render_demo_quiz.py` / `render_gemini_master.py` renderers + bundled fonts + helper shells) and `legacy/renders/` (old build scripts). Kept for reference; Remotion replaced it. |

> The committed audio in `remotion/public/audio/` and `voice/narration/` means you can **render the
> video without an ElevenLabs key or credits** — you only need the key to *regenerate* the voice.

### Prerequisites

- **Node.js 18+** and npm (for the Remotion project)
- **Python 3** and **ffmpeg** (for the voice pipeline and the archived `legacy/` render scripts)

### Render the video (Remotion)

```bash
cd remotion
npm install

# Full ~11-min master → video/renders/round-15-remotion-master.mp4
npx remotion render FullVideo ../renders/round-15-remotion-master.mp4

# Interactive preview studio
npm run studio
```

Compositions live in [`remotion/src/Root.tsx`](remotion/src/Root.tsx):

- **`FullVideo`** — landscape 16:9 (1920×1080). A `platform` prop (`youtube` | `instagram` | `tiktok`)
  swaps the outro CTA + VO/captions, and a `questionIds` prop selects the question subset (any
  order) — so the full 15-Q master and the curated 10-Q YouTube cut are the same composition:
  `npx remotion render FullVideo ../renders/videos/youtube/cut-10/youtube-10.mp4 --props='{"platform":"youtube","questionIds":[3,6,9,13,10,7,11,14,12,15]}'`
- **`Short`** — portrait 9:16 (1080×1920), same component re-flowed for vertical. The 5 shorts pass
  `platform: "instagram"` (→ "follow for more") + a 3-id `questionIds` subset:
  `npx remotion render Short ../renders/videos/shorts/short-1/short-1.mp4 --props='{"platform":"instagram","questionIds":[1,3,7]}'`
- **`Round15Slice`** — the Phase-1 vertical slice.
- **`Intro`** — the standalone intro.

The score screen scales to the subset (15 → 13-15/8-12/0-7, 10 → 9-10/5-8/0-4, 3 → 3/2/0-1); the
score VO is scale-agnostic and reused. Encode intent (yuv420p, CRF 16) is set in
[`remotion/remotion.config.ts`](remotion/remotion.config.ts).

### Repurposed cuts (YouTube long-form + 5 vertical shorts)

[`src/data/cuts.ts`](remotion/src/data/cuts.ts) is the single source of truth for every published cut
(subset + platform + aspect + folder). Regenerate all per-video metadata + subtitle sidecars with:

```bash
cd remotion
npx tsx scripts/build-cuts.ts   # writes questions.json + info.md + captions.srt/.vtt + manifest.json
```

Each cut renders into its own folder under `renders/videos/`:

```
renders/videos/
├── manifest.json                 ← index of every cut
├── youtube/
│   ├── full-15/                  ← the full 15-Q master (16:9, "subscribe")
│   │   └── round-15-remotion-master.mp4 + captions.srt/.vtt + questions.json + info.md
│   └── cut-10/                   ← curated best-10 YouTube cut (16:9, "subscribe")
│       └── youtube-10.mp4 + …
└── shorts/                       ← 5 vertical shorts (9:16, "follow for more")
    ├── short-1/ … short-5/       ← 3 Qs each, mini score /3; serve BOTH Instagram + TikTok
```

> IG + TikTok take the **same** 9:16 "follow for more" cut, so the shorts live once under `shorts/`.

### Regenerate the voice / narration (ElevenLabs)

Only needed if you want to re-synthesize audio — the mp3s are already committed.

```bash
cd voice
cp .env.example .env          # then paste your ELEVENLABS_API_KEY into .env
set -a; . ./.env; set +a      # export the key (never passed on the CLI)
python3 voice_pipeline.py check     # verify account tier + usable models
python3 voice_pipeline.py samples   # synth narration for the saved voice_id
```

- Requires `voice/.env` with **`ELEVENLABS_API_KEY`** (see `voice/.env.example`). The key is read
  **only** from the env / git-ignored `.env`, never logged or placed on the command line.
- The cloned host voice is saved in [`voice/voice_saved.json`](voice/voice_saved.json) —
  primary **"Smart Fella Host"**, `voice_id` **`3hAyeocOPpOtpEAc7laH`**.
- Scripts: `voice_pipeline.py` (design/save/samples), `clone_voice.py` (one-time clone; also reads
  optional `OLD_ELEVENLABS_API_KEY`), `gen_sfx.py`, `gen_captions.py`, `regen_all.py`, `regen_score.py`.

### Legacy ffmpeg render path (archived)

[`legacy/tools/`](legacy/tools/) holds the original ffmpeg/PIL renderers (`render_cogat_round_*.py`,
`render_gemini_master.py`, `render_demo_quiz.py`) plus bundled fonts and helper shells, and
[`legacy/renders/`](legacy/renders/) the old build scripts. They wrote masters into `renders/`. Kept
for reference — all new work happens in `remotion/`. (Paths inside these archived scripts may need
updating to run, since they moved under `legacy/`.)

### What's tracked vs ignored

- **Ignored:** `**/.env` (secrets), `**/node_modules/`, `remotion/out/` (frame dumps), `__pycache__/`,
  `renders/**/*.mp4` (all final masters + per-video cuts, recursive), fresh `voice/narration/*.bak`
  takes, `.DS_Store`.
- **Tracked:** all source + config, the SFX / narration / music audio needed to render, fonts,
  images, timelines, the per-video `questions.json` / `info.md` / `captions.srt`/`.vtt` + `manifest.json`
  under `renders/videos/`, and archived voice takes under `voice/_backups/`. No secrets, no
  `node_modules`, no `.mp4` masters.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) typechecks the Remotion project on every
push/PR (`npm ci` + `tsc --noEmit`). This is a render pipeline, not a deployed app — **there is no CD
by design.**

---

## File index

| File | What it is |
|---|---|
| [`production-brief.md`](production-brief.md) | **Strategy → pipeline bridge.** Turns the marketing PRD into objective, audience, funnel, cadence, format menu, and a per-video Definition of Done. Read after the spec. |
| [`riddle-video-style-spec.md`](riddle-video-style-spec.md) | **Master spec.** The genre in our words + the on-brand production template (format variants, backbone, layout, timers, pacing, checklists). Start here. |
| [`content/starter-quiz-bank.md`](content/starter-quiz-bank.md) | **Puzzle bank.** 30+ original, age-appropriate puzzles across every type + a repeatable "generate more" recipe. Draw from here to fill a round. |
| [`templates/script-template.md`](templates/script-template.md) | **Voiceover script template.** Reusable game-show-host VO script (ElevenLabs persona): cold-open hook, per-round beats, score patter, parent-email outro, pacing/pause cues + a fully-written example round. |
| [`templates/storyboard-shotlist.md`](templates/storyboard-shotlist.md) | **Storyboard + shot-list template.** Per-round beat→frame board mapping every on-screen element, plus an asset checklist and a filled example round (aligned to the script example). |
| [`prompts/asset-prompt-library.md`](prompts/asset-prompt-library.md) | **Ready-to-paste generation prompts** for voice (ElevenLabs), music (Suno), images, and video — all brand-locked to exact hexes/fonts. |
| [`compliance.md`](compliance.md) | **COPPA + CARU playbook.** Parent-email-only capture flow, zero-child-PII rules, CARU checklist, no-Alpha-branding rule, prize legal, on-screen + gate checklists. |
| [`repurposing.md`](repurposing.md) | **One long-form → many surfaces.** Shorts/Reels (9:16), IG/TikTok carousel, and blog — with per-format specs (dimensions, length, hook, CTA). |
| [`prizes.md`](prizes.md) | **Prize mechanic.** $500 input tier + $2,000 spotlight, entry via parent email, winner selection, and publicly documenting winners as social proof. |
| `README.md` | This index + the end-to-end workflow. |

**Brand sources (parent repo):** [`../DESIGN.md`](../DESIGN.md) (video/thumbnail design system) ·
[`../design-reference/design-tokens.md`](../design-reference/design-tokens.md) (exact tokens).

```
video/
├── README.md                     ← you are here (index + workflow)
├── production-brief.md           ← PRD → pipeline bridge (strategy)
├── riddle-video-style-spec.md    ← master format spec (craft)
├── compliance.md                 ← COPPA + CARU hard gate
├── repurposing.md                ← Shorts / carousel / blog
├── prizes.md                     ← $500 + $2,000 prize mechanic
├── content/
│   └── starter-quiz-bank.md      ← 30+ original puzzles + "generate more"
├── templates/
│   ├── script-template.md        ← host VO script template + example round
│   └── storyboard-shotlist.md    ← per-round storyboard + shot-list + example
└── prompts/
    └── asset-prompt-library.md   ← paste-ready generation prompts
```

---

## The end-to-end workflow

Each step links to the doc that governs it. **Compliance runs alongside every step and gates
publishing.**

```
CONTENT ─► SCRIPT ─► VOICE ─► VISUALS ─► MUSIC ─► ASSEMBLE ─► CAPTURE ─► PUBLISH ─► REPURPOSE
                            └──────────────── COMPLIANCE (hard gate, all steps) ───────────────┘
```

1. **Content** — set strategy (objective, cadence, format menu) from
   [`production-brief.md`](production-brief.md), pick a **format variant** + **pacing model**, and
   pull **N original, age-appropriate puzzles** from
   [`content/starter-quiz-bank.md`](content/starter-quiz-bank.md). →
   [`riddle-video-style-spec.md`](riddle-video-style-spec.md) §2, §7, §9.
2. **Script** — write the backbone beats (hook → title → question(+options) → timer → **green ✓
   reveal** → one-line explain → tiered score → **parent-email CTA**) from
   [`templates/script-template.md`](templates/script-template.md), then board them 1:1 in
   [`templates/storyboard-shotlist.md`](templates/storyboard-shotlist.md). Keep it truthful, kind,
   and CARU-safe. → spec §3; CTA wording in [`compliance.md`](compliance.md) §2.
3. **Voice** — generate host narration per beat in **ElevenLabs** (reuse the saved "Closer Kid Host").
   → [`prompts/asset-prompt-library.md`](prompts/asset-prompt-library.md) §1.
4. **Visuals** — generate/build the stage, puzzle media, mascot, and thumbnail; build UI (timer,
   option tiles, reveal kit, score card) as motion graphics. → prompt library §3–§4; spec §11–§12.
5. **Music** — generate the 4 **instrumental** cues in **Suno** (intro, thinking bed, win sting,
   wrong sting). → prompt library §2.
6. **Assemble** — edit to the timing budget; hard color-block slams, press/reveal motion
   (easeOutCubic), VO over a ducked bed, stingers on reveals. → spec §12.1, §12.2; `DESIGN.md` §7.
7. **Capture** — wire the end-screen CTA to the **parent-email gate** (parent action, parent email
   only, prize-rules link). → [`compliance.md`](compliance.md) §2; [`prizes.md`](prizes.md) §1, §6.
8. **Publish** — run the **on-screen + gate compliance checklists**, get **CARU + legal sign-off**,
   set platform "Made for Kids" flags, then ship the long-form + thumbnail. →
   [`compliance.md`](compliance.md) §6–§8.
9. **Repurpose** — spawn 3–6 **Shorts**, a **carousel**, and a **blog** post; re-run compliance per
   surface; cross-link them all back to the same gate. → [`repurposing.md`](repurposing.md).

> **Prize loop (ongoing):** each period, draw the **$500 input** + **$2,000 spotlight** winners and
> **document them publicly** — that content re-enters step 9 as social proof.
> → [`prizes.md`](prizes.md) §2–§4.

---

## Non-negotiables (memorize these)

**Compliance ([`compliance.md`](compliance.md)):**
- **Parent-email capture only** — CTA is a **parent** action ("ask a grown-up to enter their email").
- **Zero child PII** anywhere in the funnel (no name/age/school/location/photo/voice/identifier).
- **CARU-reviewed** before publishing; truthful, age-appropriate, no dark patterns.
- **No Alpha School / Alpha AI** branding — brandless except the Closer visual system.
- **Prizes** ($500 input / $2,000 spotlight) link to **public rules**; **parent** is the recipient;
  **W-9 + 1099 for any prize ≥ $600** to one household/year.

**Brand ([`../DESIGN.md`](../DESIGN.md)) — the 4 signatures:**
1. Thick pure-black outlines. 2. Hard offset shadows, **ZERO blur**. 3. **Anton** UPPERCASE + **DM
Sans**. 4. Flat bright color-blocking.

```
COLORS  ink #000000 · paper #FFFFFF · blue #839AFF · mint #C6FCD0 · coral #FD7962 · yellow #FCE552 · cream #F6F4EE
FONTS   Anton (display, UPPERCASE, tight) · DM Sans (body/UI; eyebrows 800 UPPER +tracking)
CANVAS  video 1920×1080 · Shorts 1080×1920 · thumb 1280×720 · carousel 1080×1350 · export sRGB
MOTION  press 150ms · enter 200ms · reveal 300ms · easeOutCubic (0.215,0.61,0.355,1)
REVEAL  mint ✓ = correct · coral ✗ = wrong
```

---

## Definition of done (per video)

A video is done when it passes **all four** checklists:
- [ ] **Format/asset** — spec §12.4 (per-video) + `DESIGN.md` §14 (assets).
- [ ] **On-screen compliance** — [`compliance.md`](compliance.md) §6.
- [ ] **Gate compliance** — [`compliance.md`](compliance.md) §7.
- [ ] **Repurposing + prize** — [`repurposing.md`](repurposing.md) §6 (per surface) +
      [`prizes.md`](prizes.md) §7 (per period).

> Keep it **original** (write your own puzzles/copy; license or AI-generate all media/music) and
> **on-brand** (the 4 signatures, exact hexes/fonts). When unsure about child data or a dark pattern,
> **cut it** — the funnel works with a parent email and nothing else.
