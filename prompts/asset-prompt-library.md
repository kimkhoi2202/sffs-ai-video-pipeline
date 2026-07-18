# Asset Prompt Library — Kid Loop Riddle/Quiz Videos

Ready-to-paste generation prompts for every asset in a Kid Loop riddle/quiz video, all locked to
the neo-brutalist **"Closer"** brand. Copy a prompt, swap the `{{bracketed}}` bits, generate.

> **Read first:** [`../riddle-video-style-spec.md`](../riddle-video-style-spec.md) (master format
> spec) · [`../../DESIGN.md`](../../DESIGN.md) (brand system) ·
> [`../../design-reference/design-tokens.md`](../../design-reference/design-tokens.md) (exact tokens).
>
> **Compliance is a hard gate.** Every asset here feeds a **kid-directed** funnel. Before anything
> ships it must pass [`../compliance.md`](../compliance.md): parent-email capture only, **zero child
> PII**, **CARU-reviewed**, **no Alpha School / Alpha AI branding**. Write your own puzzles and copy —
> never transcribe or reuse another creator's riddles, answers, art, voice, or music.

---

## 0. Brand lock — paste this into any generator that accepts style guidance

**The 4 non-negotiable signatures (DESIGN.md §0):** (1) thick pure-black outlines, (2) hard offset
drop-shadows with **ZERO blur**, (3) **Anton** UPPERCASE display + **DM Sans** body, (4) flat bright
color-blocking. If it has soft/blurry shadows, glows, gradients, thin/gray borders, or script fonts,
it is **off-brand — regenerate.**

```
CLOSER BRAND LOCK (paste verbatim into image/video prompts)
Style: flat neo-brutalist, sticker-sheet look. Bold flat color blocks, no gradients, no glow, no
soft shadows, no noise, no bevels, no 3D. Every object has a THICK pure-black outline and a HARD
offset drop-shadow that is a solid black copy of the shape moved down-right, ZERO blur, ZERO spread,
100% black, at a 45-degree angle. Rounded corners (~40px feel) or full pills. High contrast.
Palette (use ONLY these hex values):
  ink #000000 (all text, ALL borders, ALL shadows)
  paper #FFFFFF
  periwinkle blue #839AFF
  mint #C6FCD0
  coral #FD7962
  yellow #FCE552
  cream #F6F4EE
Rules: one dominant accent per frame, max two accents. Text is ink on any bright/paper/cream; text
is paper only on ink. Never gray or low-opacity text on color. Fonts: Anton (UPPERCASE, tight) for
headlines; DM Sans for labels/body.
NEGATIVE (never include): gradient, glow, bloom, drop-shadow blur, soft shadow, lens flare, bokeh,
photorealism, 3D render, bevel, emboss, grunge/noise texture, watercolor, thin lines, gray borders,
serif or script fonts, extra colors outside the palette.
```

**Pixel scale @1080p (DESIGN.md §4):** standard border **4px**, emphasis border **8px**; hard
shadows — badge **4px**, button **8px**, card **12px**, feature **16px**, hero **24px**; card radius
**40px**; buttons/badges full pill. Thumbnails (1280×720) scale heavier: border **6px**, card shadow
**16px**, hero shadow **28–36px**, radius **44px**.

**Canvases (DESIGN.md §6):** video **1920×1080**, thumbnail **1280×720**, Shorts/Reels **1080×1920**,
carousel **1080×1350** (or 1080×1080). Export **sRGB**.

**Motion (DESIGN.md §7):** press **150ms**, enter **200ms**, reveal **300ms**, easeOutCubic
`(0.215, 0.61, 0.355, 1)`. Objects "press into their shadow." Hard color-block slams beat cross-dissolves.

---

## 1. ElevenLabs — the game-show HOST voice

The narrator is a **high-energy, mischievous game-show announcer** — the same voice character/energy
as the **"Smart Fella or Fart Smella"** Fella Test host (`app/smart-or-fart/page.tsx`), **dialed to
an all-ages, kid-safe register**: warm, silly, encouraging, never sarcastic-at-the-kid's-expense,
never scary, never condescending. Think "friendly cartoon quiz-master who is genuinely rooting for
you."

> **Reuse for consistency:** if the Fella Test host voice already exists in your ElevenLabs
> workspace/Voice Library, **reuse that exact saved voice** across the whole Kid Loop so every video
> sounds like the same host. Only design a new voice if you need a fresh, brandless host.

### 1.1 Voice Design prompt (paste into ElevenLabs → Voice Design)

```
A warm, high-energy game-show host, gender-neutral-leaning, sounds early 30s, neutral American
accent. Playful and mischievous but kind — a friendly cartoon quiz-master who is genuinely rooting
for the player. Bright, punchy, bouncy delivery with big dynamic range: leans in conspiratorially
to set up a riddle, then explodes with delight on the reveal. Crisp diction, clean studio sound,
no background noise. All-ages and kid-safe: never sarcastic at the listener's expense, never scary,
never condescending. Think a modern kids' game-show announcer with a wink.
```

**Preview text to audition the design (kid-safe, original):**

```
Only three out of ten brains crack this one... can YOURS? Look closely — you've got five seconds.
Five... four... three... [gasp] time's up! And the answer is... the little blue star! Nice work,
big brain — grab a grown-up, and let's do another.
```

Generate ~3 previews, pick the punchiest, **save it with a clear name** (e.g. `Closer Kid Host`).

### 1.2 Recommended settings

| Model | When | Why |
|---|---|---|
| **Eleven v3** | Default for narration | Best expressiveness + inline **audio tags** (`[excited]`, `[laughs]`) for the game-show energy. |
| **Multilingual v2** | Max stability / long reads | Most consistent take-to-take; fewer surprises. |
| **Turbo / Flash v2.5** | Drafts / scratch VO | Fast + cheap for timing tests before the final render. |

**Slider starting point (host energy):**

| Setting | Value | Note |
|---|---|---|
| **Stability** | **35–45** ("Creative"/expressive) | Lower = more emotion & range. Too low drifts — re-roll if it wanders. |
| **Similarity** | **80** | Keeps the saved host identity locked across videos. |
| **Style exaggeration** | **35–45** | Adds theatrical punch; above ~55 it can destabilize — back off if artifacts appear. |
| **Speaker boost** | **On** | Tighter presence. |
| **Speed** | **1.0–1.08** | Slightly brisk for retention; slow to ~0.95 for the "think" setup, speed up on reveals. |

> For consistency across a series, **lock one settings preset** and reuse it. Regenerate any take
> that mispronounces a name or drifts off-character rather than shipping it.

### 1.3 Scripting narration in ElevenLabs Studio

1. **New Project** in Studio; set the language and assign your saved **`Closer Kid Host`** voice.
2. **Paste the script broken into one paragraph per beat** (hook / title / each riddle setup /
   countdown / reveal / explain / score / parent-email CTA). One block per beat = clean per-segment
   audio the editor can drop against each on-screen card.
3. **Direct the read with punctuation + (v3) audio tags:**
   - Suspense before a reveal: `...` (ellipses) and short lines.
   - Emphasis: CAPS on the key word (`the BLUE one`), or bold beats with line breaks.
   - v3 tags inline: `[excited]`, `[whispers]`, `[laughs]`, `[gasp]`, `[sighs]`. Use sparingly —
     1–2 per beat max, all kid-safe.
   - Countdown cadence: put each number on its own short line so the pause reads as a tick:
     `Five.` / `Four.` / `Three.` / `Two.` / `One!`
4. **Render per beat**, name clips by beat (`r3-setup`, `r3-reveal`), and export **WAV**. Keep the
   music bed (§2) on a separate track so you can duck it under VO in the editor.
5. **CARU pass:** every line must be truthful, age-appropriate, non-manipulative, and the CTA must be
   a **parent** action. No "enter your own email," no fake scarcity, no "tell your friends or lose."

### 1.4 Example beat scripts (original, kid-safe — write your own per video)

**Hook + title (Beat 1):**

```
[excited] Only seven percent of people get all five of these right. Think you've got what it takes?
Let's find out — it's RIDDLE RUSH!
```

**Riddle setup → countdown → reveal → explain (one round):**

```
(setup) Okay, eyes up. Which shape does NOT belong with the others? Take a good look...
(countdown) You've got five seconds. Five... four... three... two... one!
(reveal) [gasp] It's the triangle! Every other shape has four sides — the triangle's the odd one out.
(explain) Count the sides next time and you'll spot it in a snap. Great eyes!
```

**Score + parent-email CTA (outro — parent action only):**

```
[excited] Add 'em up — how'd your brain do today? Want your full brain score and a shot at the prizes?
Ask a grown-up to pop their email in on screen, and we'll unlock it. See you next riddle!
```

---

## 2. Suno — instrumental music & stingers

Four **instrumental** cues per series (build once, reuse): **intro theme**, **question/thinking bed
(loopable)**, **win sting**, and a comedic **wrong-answer sting**. Translate the brand energy to
sound: **bold, punchy, high-contrast, playful** — a modern kids' game-show (funky brass/synth,
bouncy percussion, chiptune sparkle), clean and non-scary.

**How to prompt Suno:** turn **Instrumental ON** (no vocals), keep the **Style** field to genre +
instruments + mood + tempo, keep it short. Suno won't guarantee a seamless loop — generate a
simple, even section and **trim/crossfade to the bar in your editor** to loop. Generate a few
variations and keep the cleanest.

| Cue | Length | Tempo | Use |
|---|---|---|---|
| Intro theme | 8–15 s | ~120–130 BPM | Hook/title card energy |
| Thinking bed (loop) | 15–30 s, loopable | ~90–105 BPM | Under every riddle + countdown |
| Win sting | 1–2 s | — | Correct reveal (`mint ✓`) |
| Wrong sting (comedic) | 1–2 s | — | Wrong answer (`coral ✗`) — silly, not mean |

### 2.1 Example prompts (all Instrumental = ON)

**Intro theme:**
```
Upbeat retro game-show intro, instrumental, no vocals. Punchy funky brass stabs, bouncy syncopated
drums, bright synth arpeggio, playful clap. Bold, high-energy, fun, all-ages, confident. ~125 BPM.
Clean modern mix, big finish on the downbeat.
```

**Question / thinking bed (loopable):**
```
Loopable light suspense bed, instrumental, no vocals. Bouncy muted pizzicato plus a soft ticking
pulse, minimal playful marimba, curious and fun (not scary, not dark). Steady, even, low-key so a
voiceover sits on top. ~96 BPM. Simple 8-bar phrase that repeats cleanly.
```

**Win sting:**
```
Short triumphant success sting, instrumental, no vocals. Bright ascending brass-and-synth fanfare
with a sparkle chime and a satisfying pop. Happy, rewarding, one to two seconds, clean tail.
```

**Wrong-answer sting (comedic):**
```
Short comedic "wrong answer" sting, instrumental, no vocals. Playful descending trombone wah-wah
plus a light boing, goofy and friendly — funny, never harsh or scary. One to two seconds, clean tail.
```

> **Music compliance:** must be **original/AI-generated or fully licensed** for commercial +
> monetized kids' content across all platforms. Keep it non-scary and age-appropriate (CARU).

---

## 3. Image generation — backgrounds/stage, puzzle media, mascot, thumbnail

For GPT Image / Nano-Banana / Ideogram / SDXL etc. **Always append the §0 Brand Lock block.** Ideogram
and GPT Image render **crisp in-image text** best — prefer them when a graphic needs the Anton
headline baked in. Otherwise generate art with a transparent/flat area and **set the real type in
Figma/After Effects** (guaranteed correct Anton/DM Sans + exact hexes).

**Guardrails baked into every image prompt:** *hard offset shadow, zero blur; thick pure-black
border; flat solid colors only; no gradients/glow/soft shadow/3D/noise.*

### 3.1 Stage background / segment block

*Purpose: the consistent "stage" behind each round — rotate the dominant accent per round.*

**Example A (flat stage block):**
```
A flat neo-brutalist game-show stage background, 1920x1080. Solid {{yellow #FCE552}} full-bleed
color field. A subtle repeating sticker pattern of tiny black-outlined question marks and stars in
one corner, low density, flat. A thin pure-black inner frame 8px inset from the edges. Wide empty
center for a puzzle panel and headline. Flat, bold, high contrast.
+ [PASTE §0 BRAND LOCK]
```

**Example B (rotating accent + shapes):**
```
Flat neo-brutalist stage, 1920x1080, solid {{periwinkle blue #839AFF}} background. A few large
black-outlined flat geometric stickers (circle, triangle, squiggle) in mint and coral scattered at
the edges, each with a hard offset black shadow (zero blur), rotated 3-6 degrees. Center kept clear
for content. No gradient, no glow.
+ [PASTE §0 BRAND LOCK]
```

### 3.2 Puzzle media (the "sticker photo frame")

*Purpose: the object(s) the viewer solves — inside a black-bordered, hard-shadow panel. Keep puzzles
**original, age-appropriate, solvable in seconds** from one screen.*

**Example A (odd-one-out / count-the-things):**
```
Flat vector illustration for a kids' visual riddle: a neat row of five coffee-mug icons, four facing
right and ONE facing left, on a {{cream #F6F4EE}} panel. Each mug is a flat solid color from the
palette with a thick pure-black outline. The whole panel has a 4px black border, 40px rounded
corners, and a hard offset black drop-shadow (12px down-right, zero blur). Simple, clear, uncluttered.
+ [PASTE §0 BRAND LOCK]
```

**Example B (spot-the-difference, 2-up):**
```
Two side-by-side flat illustration panels for a spot-the-difference puzzle, kid-friendly park scene
(tree, bench, sun, bird). Panels are near-identical with exactly THREE small differences. Each panel:
flat solid palette colors, thick black outlines, 4px black border, 40px radius, hard offset black
shadow (12px, zero blur), separated by a 10px solid black vertical divider. Clean, bold, no gradients.
+ [PASTE §0 BRAND LOCK]
```

### 3.3 Character / mascot

*Purpose: a brandless, kid-safe recurring mascot (host sidekick / "brain" buddy). No Alpha mascots,
names, or likenesses.*

**Example A (mascot turnaround):**
```
A friendly flat neo-brutalist cartoon mascot: a rounded lightbulb-brain character with big simple
eyes, little arms, and a cheerful smile. Flat {{yellow #FCE552}} body, {{coral #FD7962}} cheeks,
thick pure-black outline everywhere, hard offset black shadow (zero blur). Full body, front view,
neutral pose, transparent or flat {{mint #C6FCD0}} background. Simple, bold, all-ages, huggable.
No gradient, no glow, no 3D.
+ [PASTE §0 BRAND LOCK]
```

**Example B (mascot reaction pose for reveals):**
```
The same flat lightbulb-brain mascot, celebrating: arms up, big happy eyes, tiny sparkle stars
(black-outlined, flat) around its head. Flat yellow body, thick black outline, hard offset black
shadow (zero blur), transparent background, 3-6 degree playful tilt. Kid-safe, joyful.
+ [PASTE §0 BRAND LOCK]
```

### 3.4 Thumbnail (1280×720)

*Purpose: the click. ≤6 words, one focal point, cap-height ≥90px, clear bottom-right (duration
stamp). Recipes in DESIGN.md §9.*

**Example A (Recipe B "number flex"):**
```
YouTube thumbnail 1280x720, flat neo-brutalist. Solid {{ink #000000}} background. A giant Anton
UPPERCASE yellow number "5" filling the left ~60%, thick black outline, hard offset black shadow
(28px, zero blur). To the right, a black-bordered rounded panel (16px hard shadow) showing a simple
flat puzzle (three shapes, one odd). A small rotated coral pill sticker reading "CAN YOU?" top-right.
Bold, high contrast, readable when tiny. Two accents max.
+ [PASTE §0 BRAND LOCK]
```

**Example B (Recipe A "big claim + mascot"):**
```
YouTube thumbnail 1280x720, flat neo-brutalist. Solid {{yellow #FCE552}} background, 8px black inner
frame. Left: Anton UPPERCASE ink headline "ONLY 7% CAN" with the word "SOLVE THIS" in a coral box.
Right 40%: the flat lightbulb-brain mascot in a black-bordered rounded panel with a hard offset
shadow, tilted 4 degrees. One yellow star sticker. ≤6 words, cap-height huge. Clear bottom-right.
+ [PASTE §0 BRAND LOCK]
```

> After generating, **verify at 168×94px** (mobile size). If the headline isn't instantly readable,
> fewer words / bigger type. For guaranteed-correct type, generate the art only and **set the Anton
> headline in Figma** over the exported panel.

---

## 4. Video generation — animated segments & b-roll

For Runway (Gen-3/4), Kling, Google Veo, Sora, Pika, or Luma. **Most on-brand path = image-to-video:**
generate a still in §3, then animate it so the flat look survives. Keep the **camera locked**, motion
**snappy and physical** (press/pop/slam, easeOutCubic), and cuts **hard** — no cinematic drift, no
depth-of-field, no relight.

**Append to every video prompt:**
```
Flat 2D motion-graphic style, locked static camera, no camera movement, no parallax, no depth of
field, no relighting, no photorealism. Objects animate with snappy physical "press" and "pop" moves.
Keep thick black outlines and hard zero-blur offset shadows at all times. + [PASTE §0 BRAND LOCK]
```

### 4.1 Example prompts

**Intro stage reveal (title moment):**
```
Image-to-video from the stage still: flat color blocks slam into place one by one from off-screen,
each carrying its hard black shadow, then a big Anton UPPERCASE title card pops in (scale 96% to
100%) and settles with a tiny bounce. 3 seconds, snappy, easeOutCubic. + [PASTE VIDEO SUFFIX]
```

**B-roll interlude (kids thinking — flat, non-PII, generic):**
```
Flat neo-brutalist animated b-roll: a simple cartoon kid character (brandless, generic) taps a
finger on chin, a black-outlined thought-bubble with a flat question mark pops above their head and
wobbles. Loop-friendly, 4 seconds, locked camera, bold flat colors. + [PASTE VIDEO SUFFIX]
```

**Transition slam (between rounds):**
```
A solid {{coral #FD7962}} color block wipes across the frame from right to left carrying a hard
black shadow, briefly covering everything, then snaps away to reveal the next scene. Hard cut feel,
0.3s, easeOutCubic, no blur. + [PASTE VIDEO SUFFIX]
```

**Mascot idle loop (corner bug):**
```
Image-to-video from the mascot still: the flat lightbulb-brain mascot gently bobs and blinks, tiny
sparkle appears and disappears. Seamless 3-second loop, transparent/flat background, locked camera,
outlines and hard shadow preserved. + [PASTE VIDEO SUFFIX]
```

> **Countdown timers, reveals (`mint ✓` / `coral ✗`), option-tile presses, and score cards** are
> best built as **real motion graphics** (After Effects / Figma → AE) using the component library in
> the master spec (§12.3) — generative video won't nail the exact tokens or the tick-accurate timer.
> Use AI video for **backgrounds, b-roll, mascot, and organic transitions** only.

---

## 5. Per-asset compliance quick-check (before you generate or ship)

- [ ] **No child PII** anywhere in the asset or the funnel it feeds (see [`../compliance.md`](../compliance.md)).
- [ ] **No Alpha School / Alpha AI** name, logo, mascot, color, or URL — brandless except the Closer system.
- [ ] Any prize mention links to **public rules** (parent-facing) — see [`../prizes.md`](../prizes.md).
- [ ] CTA is a **parent-email** action, plainly worded — never "enter your own email."
- [ ] Puzzles/copy/music are **original** (or fully licensed) and **CARU-safe** (truthful, kind, non-scary).
- [ ] On-brand: thick black outlines, hard zero-blur shadows, Anton + DM Sans, flat palette hexes only.

---

### Related docs
[`README.md`](../README.md) · [`riddle-video-style-spec.md`](../riddle-video-style-spec.md) ·
[`compliance.md`](../compliance.md) · [`repurposing.md`](../repurposing.md) ·
[`prizes.md`](../prizes.md)
