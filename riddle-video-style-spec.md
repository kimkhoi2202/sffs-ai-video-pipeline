# Riddle / Quiz Video — Master Style & Format Spec (Canonical)

The single canonical reference for producing **original** "test your brain" riddle/quiz videos in
the popular puzzle-video genre, re-skinned to the neo-brutalist **"Closer"** brand system
(`DESIGN.md`). Synthesizes the analysis of **8 reference videos** across three analysis batches.

> **What this is:** genre conventions in our own words + a concrete on-brand production template.
> **What this is NOT:** a copy of any specific video. Do not transcribe narration, reuse anyone's
> riddles/answers, or redistribute frames/assets. Analysis frames were kept in `/tmp` only and are
> not part of this repo. Write your own puzzles and your own copy.

> **Provenance note:** batch-A/-B raw notes (`video/analysis/notes-batch-*.md`) were not present on
> disk when this revision was folded in; their **conclusions were incorporated from the task brief**
> (confirmed backbone, the three format variants, timer options, pacing options). If those notes
> contained additional evidence, re-drop them in `video/analysis/` and re-run the merge.

---

## Section outline
0. **Kid Loop & Compliance (COPPA / CARU) — READ FIRST**
1. The genre in one breath
2. **Format variants** — choose your sub-genre (+ polish spectrum)
3. **The common backbone** (confirmed across all 8)
4. Source-video technical profile (reference)
5. Segment structure & the riddle-round loop
6. On-screen layout & recurring elements
7. Puzzle-type menu
8. **Countdown timer** — options & on-brand re-skin
9. **Pacing & length options** (slow-deep / fast-long / short-form 9:16)
10. Typography, color, transitions, audio (observed)
11. Adapting the format to the "Closer" neo-brutalist brand (the re-skin)
12. Reusable production template (budgets, recipes, components, checklist, example)
13. Repurposing: short-form + carousel + blog
14. What could not be determined from frames alone

---

## 0. Kid Loop & Compliance (COPPA / CARU) — READ FIRST

These videos are the marketing **"Kid Loop"** in the project PRD. Every video is an
audience-building funnel whose single job is to move a kid to a **results gate that captures a
PARENT'S email** — never the child's data. **Compliance is a hard gate, not a nice-to-have.** If a
concept can't satisfy every rule below, it does not ship.

**Non-negotiable rules**
- **Parent-email capture only.** The funnel CTA is a **parent** action, worded plainly, e.g.
  *"Ask a parent to enter their email to unlock your results/score."* The landing/gate collects a
  **parent email address and nothing else at entry.**
- **Zero child PII.** Collect **no** name, age, birthday, school, location, photo, voice, device
  ID, or persistent identifier from the child anywhere in the flow (video, gate, or follow-up).
- **CARU-reviewed.** Every script, on-screen claim, prize framing, and the gate flow must pass
  **CARU (Children's Advertising Review Unit)** review **before publishing.** Keep claims truthful,
  age-appropriate, and non-manipulative (no fake scarcity, no dark patterns, no "tell your friends
  or lose your prize").
- **No Alpha branding.** Carry **no Alpha School / Alpha AI** names, logos, mascots, colors, or
  URLs. The videos ship under the neutral **"Closer"**-style brand only. (Do not imply school
  affiliation.)
- **Prize mechanic (publicly documented).** Support the two-tier prize: a **$500 input-tier**
  reward and a **$2,000 spotlight** reward. Rules, eligibility, odds/selection, and winner terms
  must be **publicly posted** and linked from the gate; prize copy must be parent-facing and
  CARU-safe.

**On-screen implications (bake into the template)**
- The end-screen CTA card says a **parent** action (see §11.10) — never "enter YOUR email."
- Any prize mention on-screen links to the **public rules** (lower-third URL / end card), framed
  for a parent.
- No data-collection UI appears **inside the video**; the video only points to the gate.
- Keep it brandless per above; the only "brand" is the Closer visual system.

**Compliance checklist (per video)**
- [ ] CTA is a **parent-email** action, plainly worded; no child data requested on-screen.
- [ ] **No child PII** anywhere in the funnel; gate collects parent email only.
- [ ] Script + claims + prize framing + gate **submitted to CARU** and cleared.
- [ ] **No Alpha School / Alpha AI** branding, names, or affiliations.
- [ ] Prize tiers ($500 input / $2,000 spotlight) shown with a link to **public rules**.
- [ ] No dark patterns, no false urgency, age-appropriate difficulty and tone.

---

## 1. The genre in one breath

A fast, **voiceover-driven** montage of self-contained visual puzzles. Each puzzle is a single
"can you solve this?" screen on a **look-at-me graphic background**, gated by a **visible countdown
timer** that dares the viewer to answer in time, then resolved with an **explicit reveal**
(**green = correct**) and a one-line explanation. Puzzles are strung together with punchy bumper
cards, tallied into a **tiered score**, and capped with a **subscribe / watch-next** end screen.
Snappy, high-contrast, retention- and comment-engineered — not cinematic.

---

## 2. Format variants — choose your sub-genre

Pick **one** variant per video (don't blend the reveal grammars). All three share the §3 backbone
and re-skin to the same brand.

### (a) Multiple-choice **quiz-board**
- **Look:** top **question banner** + a set of **A–D option pills/tiles** + **countdown** +
  **green ✓ reveal** on the correct option (wrong = red/✗).
- **When to use:** trivia/knowledge, "which is right?", broad/mainstream topics, **highest
  shareability & comment bait** ("I got 8/10"), easiest to template and mass-produce, easiest to
  keep CARU-safe (objective answers).
- **Brand map:** banner = bordered `ink`/accent card, **Anton UPPERCASE**; options = bordered
  accent **tiles/pills** (rotate {blue, mint, coral, yellow}), `ink` text; select/reveal uses the
  **press** motion; **correct = `mint` ✓ badge**, **wrong = `coral` ✗ badge**.

### (b) **Open riddle** with annotated reveal
- **Look:** puzzle image/prompt (no fixed options) + **countdown** + a reveal that **annotates the
  media** (lasso/arrow/circle) or reorients it to show the answer.
- **When to use:** optical illusions, spot-the-difference, hidden-object, lateral-thinking,
  count-the-things. More "aha", great for **pause-and-solve** engagement.
- **Brand map:** media in a **sticker photo frame** (black border + hard shadow); reveal via
  **coral/ink lasso + arrow stickers**, a **`mint` ✓** confirmation, and big **Anton** numerals for
  counts. Flat, bordered, zero-blur — no marker-scribble texture.

### (c) Fully-**animated narrative riddle** (diegetic)
- **Look:** a short **story/scenario animation** (characters, a dilemma) that poses the puzzle
  **inside the scene** — typically **no option pills and no visible timer**; the "think now" beat is
  a scripted pause. Higher production cost.
- **When to use:** "escape/survival"-style logic riddles, storytelling hooks, premium flagship
  pieces; strongest emotional pull and rewatch value.
- **Brand map:** keep characters/scenes flat and bold; frame **title/answer cards** in the brand
  (Anton on color blocks, bordered, hard shadows). Reveal is a **scene resolution** plus a bordered
  answer card. Use the brand for all typographic/UI moments even when the scene art is illustrative.

### Polish spectrum (independent of variant)
`lean/flat` → `standard` → `premium 4K`:
- **Lean/flat:** flat color-blocks, static/simple motion, stock or vector media, 1080p. Fast/cheap,
  ideal for **volume** and testing. (Our brand looks *intentional* even at lean tier.)
- **Standard:** motion graphics, custom illustration/photography, sound design, 1080p.
- **Premium 4K:** full animation (variant c), bespoke art, VO talent, 4K master. Reserve for
  **flagship** funnels / the $2,000-spotlight tier.

> Match variant + polish to goal: **(a) lean** for volume/shareable quizzes; **(b) standard** for
> aha-driven engagement; **(c) premium** for flagship storytelling.

---

## 3. The common backbone (confirmed across all 8)

Every analyzed video — regardless of variant — follows this spine. **Keep this order; re-skin the
surface.**

1. **Hook / "X% fail" title.** An opening claim that dares the viewer (e.g. *"Only ___% can solve
   this"*). Sets stakes in the first seconds. (Write your own; keep it truthful & CARU-safe.)
2. **Number / title card.** Names the promise and the count ("N riddles / questions").
3. **Question (+ options).** One question per screen; options present in variant (a).
4. **Visible countdown timer.** A fixed think-window the viewer can *see* draining (§8).
5. **Explicit reveal — green = correct.** The answer is shown unambiguously; **correct is coded
   green (✓)**, wrong red (✗). (Open-riddle reveals annotate the media.)
6. **One-line explanation.** A single beat of "why", then move on.
7. **Tiered scoring.** A running / final score bucketed into tiers (e.g. novice / sharp / genius).
8. **Branded subscribe / watch-next end screen.** Engagement CTA + subscribe + next-video — and,
   for us, the **parent-email results gate** (§0, §11.10).

---

## 4. Source-video technical profile (reference only)

From the primary reference analyzed frame-by-frame:

| Property | Value |
|---|---|
| Resolution | 1920×1080 (16:9) |
| Frame rate | 25 fps, H.264 High |
| Duration | ~485 s (~8:05) |
| Audio | AAC stereo, 44.1 kHz (voiceover + music bed) |
| Puzzle count | 7 riddles |
| Delivery | Landscape long-ish-form |

Container takeaway: **~8 min / ~7 puzzles / landscape / narration-led with a music bed** is a
proven baseline. See §9 for slow-deep, fast-long, and short-form alternatives.

---

## 5. Segment structure & the riddle-round loop

Timings are **approximate** (frame sampling was 1/12 s → treat as ±6 s budgets, not exact cuts).

| # | Segment | Approx. budget | Purpose |
|---|---|---|---|
| 1 | Hook / "X% fail" + title card | 0:00–0:18 | Promise + stakes + energy |
| 2 | Bumper / transition card | 2–4 s each | Momentum between rounds |
| 3 | Riddle round ×N | 30–60 s each | Question → countdown → reveal → explain |
| 4 | B-roll / interlude | 8–15 s, a few times | Pacing + relatability |
| 5 | Tiered score + outro CTA | ~15–25 s | "What's your score? / parent-email gate" |
| 6 | End card | ~5–10 s | Subscribe + watch-next + watermark |

**The round loop (repeat ×N):** setup (VO) → question on screen → countdown → suspense beat/stinger
→ reveal (green ✓) → one-line explanation → bumper/score tally → next. Escalate difficulty across
rounds and vary the puzzle type (§7) so no two consecutive rounds feel alike.

---

## 6. On-screen layout & recurring elements (observed)

- **A consistent "stage" background** unifies every round (reference used a cool navy→blue low-poly
  "plexus" network). We replace it with **flat brand color-blocks** (§11.1).
- **Two question-text treatments:** a **banner bar** (docked top/bottom over media) and a
  **full-width band/card** (for text-only puzzles).
- **Media framing:** puzzle photo/illustration in a **centered panel**; comparison puzzles use
  **two side-by-side panels**.
- **Multiple-choice layouts:** a horizontal row of options — numerals or lettered A–D — under the
  question.
- **Countdown timer UI:** a visible depleting indicator; placements seen at **left margin
  (vertical)** and **bottom center (horizontal)** (full menu in §8).
- **Reveal:** **green = correct / red = wrong**, plus annotations (circle/lasso/arrow) or reorienting
  the media; big numerals for counts.
- **B-roll interludes:** relatable people footage for pacing.
- **Outro + end card:** comment bait + subscribe/next; for us, the parent-email gate.

---

## 7. Puzzle-type menu (pick N, keep varied — write your own)

1. Spot-the-difference / spot-the-error.
2. Count-the-things (reveal with circled numbers).
3. Optical illusion / hidden object (dashed-outline reveal).
4. Odd-one-out / which-doesn't-belong.
5. Perception trick (which is bigger? A vs B).
6. Lateral-thinking / word riddle (text card).
7. Sequence / pattern (what comes next?).
8. Knowledge trivia (best fit for the MC quiz-board variant).

> Keep each puzzle **original, age-appropriate, and solvable in seconds** from one screen. Never
> reuse specific puzzles or answer art from any existing video.

---

## 8. Countdown timer — options & on-brand re-skin

The genre uses several timer shapes. **Re-skin all of them to our signature: pure-black border +
flat accent fill (yellow = default high-energy) + hard offset shadow (zero blur).** Optionally overlay
an **Anton numeral**. No gradients, glows, or hatch textures.

| Genre timer | What it is | Closer re-skin |
|---|---|---|
| **Numeral box** | A number counting 5→1 in a box | **Anton "number flex"** in a **bordered box** (yellow fill / ink text), each tick **presses in** with a thock |
| **Ring** | Circular stroke that empties | **Bordered circle** with a **flat accent arc** depleting (segmented, flat) |
| **Pie** | Radial wedge shrinking | **Bordered circle** with a **flat accent pie wedge** shrinking |
| **Sweep** | Clock hand sweeping | **Bordered circle** + a **thick black hand** sweeping to empty |
| **Bar** (default) | Linear fill draining | **Flat `yellow` fill + black border + hard shadow**, horizontal (bottom) or vertical (left), radius pill/40px |

**Rules:** keep the timer inside **action-safe** and clear of the lower-third and the duration
stamp. For **Shorts**, prefer the **Anton number-flex** (big, legible at a glance). Motion:
`easeOutCubic`, tick **press 150ms** (`DESIGN.md` §7).

---

## 9. Pacing & length options

Pick a pacing model to fit the goal and the algorithm target.

### Slow-deep
- **~15–20 items, ~30–45 s each → ~10–15 min.**
- Room for narration, real explanation, harder puzzles, and difficulty escalation.
- Best for **watch-time / retention**, depth, and "smart" positioning. Fewer, better rounds.

### Fast-long ("Parts")
- **~50 items, ~8–15 s each, grouped into themed "Parts"** (e.g. *Part 1: warm-up · Part 2:
  illusions · Part 3: expert*) → **15–30+ min** bingeable compilation.
- Chapter markers per Part; rapid question→countdown→reveal cadence.
- Best for **"value-packed" bingeing**, session length, and playlisting.

### Short-form (TikTok / IG Reels / Shorts, 9:16)
- **Vertical 1080×1920, 20–45 s**, **1 puzzle** (or 3 rapid-fire).
- Stack elements vertically; **big Anton number-flex timer**; one punchy reveal; **one CTA** = the
  **parent-email gate** (§0). Hook in the **first 1–2 s** ("X% fail").
- **Cut-down from the long-form:** lift a single strong round, re-crop media to 9:16, enlarge type,
  compress the loop. Every long-form video should spawn several Shorts.

> **PRD alignment:** ship **short-form (9:16)** as a first-class cut, plus **carousel** and **blog**
> repurposing (see §13). One puzzle set → many surfaces.

---

## 10. Typography, color, transitions, audio (observed → we standardize)

- **Type (observed):** a **condensed display** title (light fill + colored offset shadow) + a
  **casual hand-drawn/marker** question font; almost all **UPPERCASE**, one idea per screen. →
  **We standardize on Anton (display) + DM Sans (UI).**
- **Color (observed):** cool base + warm accents (gold/yellow timer, **green ✓ / red ✗** reveals),
  high contrast. → **We use ink/paper + blue/mint/coral/yellow/cream; mint = correct, coral =
  wrong.**
- **Transitions (observed):** hard cuts + bumper cards + simple wipes; pacing carried by VO +
  music. → **We use hard color-block slams + Anton word bumpers, easeOutCubic.**
- **Audio (inferred):** voiceover + music bed + reveal stingers. → **Punchy clicks/thocks/slams on
  presses and reveals; nothing ambient.**

---

## 11. Adapting the format to the "Closer" neo-brutalist brand

Same **format**, re-skinned to the four non-negotiable signatures (`DESIGN.md` §0): **(1) thick
pure-black outlines, (2) hard offset shadows with ZERO blur, (3) Anton UPPERCASE display + DM Sans,
(4) flat bright color-blocking.** Palette: `ink #000`, `paper #fff`, `blue #839AFF`, `mint #C6FCD0`,
`coral #FD7962`, `yellow #FCE552`, `cream #F6F4EE`. Use the **1080p pixel scale** from `DESIGN.md`
§4 (border **4px**, card shadow **12px**, hero shadow **24px**, radius **40px**, all shadows 45°
pure black).

### 11.1 Stage background → flat color-blocks
Replace any plexus/gradient with a **flat brand color block**, **rotated per round** so neighbors
differ (`blue → cream → ink → coral → mint → yellow → …`). Texture (if any) = a subtle **bordered
sticker pattern** on `ink`. Never gradients/glows/soft noise. One dominant accent per frame.

### 11.2 Question presentation → bordered hard-shadow card
- **Banner card (over media):** `ink` card + `paper` text, or a bright accent band + `ink` text,
  docked top/bottom. **Anton UPPERCASE**, 4px border, 12px hard shadow, radius 40px.
- **Text-only card:** full-width accent band (yellow = highest energy) + big Anton UPPERCASE
  question in `ink`. Section title 64–90px; body DM Sans 30–40px (`DESIGN.md` §3).
- One question, ≤ ~8 words, inside title-safe (96px)/action-safe (10%).

### 11.3 Puzzle media → the "sticker photo frame"
Every image in a **black-bordered, rounded (40px) panel + hard offset shadow (12–16px)**.
Comparison = two panels + **8–12px black center divider** (Recipe C, `DESIGN.md` §9); optionally
rotate one panel 3–6°. Cut-out subjects may overlap the frame edge.

### 11.4 Multiple choice (variant a) → bordered option tiles/pills
Options as **bordered, hard-shadow tiles** (rounded squares) or **pills** (A–D), **one accent per
option**, `ink` text, rotate colors. **Select/reveal uses press** (`DESIGN.md` §7): chosen option
presses into its shadow; **correct → `mint` ✓ badge**, **wrong → `coral` ✗ badge**.

### 11.5 Countdown timer → §8 re-skin
Default = **flat `yellow` fill + black border + hard shadow** bar; or the **Anton number-flex**.
Both orientations; keep action-safe.

### 11.6 Answer reveal → brand annotations (flat, bordered)
Open-riddle reveals: **coral/ink lasso + arrow stickers** (bordered, hard shadow), a **`mint` ✓**
confirmation, and **Anton** numerals that pop/press in. Reorient media with a **hard card slam**,
never a cross-dissolve. All marks flat, zero blur.

### 11.7 Title/hook ("X% fail") → brand title card
**Anton UPPERCASE** headline on an accent/`ink` block, **eyebrow pill** kicker, and **one word/number
boxed** in a second accent (coral/yellow) — Recipes A/B (`DESIGN.md` §9). Replace bokeh/glow motifs
with flat blocks + a **bordered line-icon tile** (lucide brain/lightbulb, recolored `ink`). No glow.

### 11.8 Bumpers/transitions → hard color-block slams
Hard color-block wipes / card slams (object carries its shadow) or a big **Anton word bumper** on a
rotating accent block. Default `easeOutCubic (0.215,0.61,0.355,1)`; **press 150 / enter 200 / reveal
300 ms**. Punchy click/thock/slam SFX.

### 11.9 Scoring → tiered score card
Running tally + a final **tier card**: big **Anton** score number (Recipe B "number flex") on an
accent/`ink` block, tier label in a bordered pill (e.g. novice / sharp / genius — write your own,
CARU-safe, non-shaming). ✓/✗ recap row uses mint/coral badges.

### 11.10 Outro + end card → brand end screen **+ parent-email gate**
- **Engagement + gate CTA:** an `ink` card + accent band, Anton UPPERCASE — worded as a **parent
  action**: *"Ask a parent to enter their email to unlock your results."* (See §0.)
- **End screen** (`DESIGN.md` §8): bordered, hard-shadow **Subscribe / Watch-next / Playlist** cards
  on one accent block, ~60px margins, channel name in a pill, **150×150 bordered watermark**.
- If prizes are shown, add a bordered pill/lower-third linking to **public prize rules** (parent-facing).

### 11.11 Safe zones & export
Title-safe 96px / action-safe 10%; keep bottom-right ~120×60px clear. Export **sRGB (Rec.709),
1080p (or 4K for premium) H.264 MP4**; **all shadows zero-blur, all borders pure black**.

### Genre → brand quick map

| Genre element | Reference look | Closer on-brand version |
|---|---|---|
| Stage background | Blue plexus network | Flat accent color-block, rotate per round |
| Question banner | Dark bar / cream band, marker font | Bordered hard-shadow card, **Anton UPPERCASE** |
| Media frame | Light border + soft shadow | Black-bordered rounded panel + **hard** shadow (sticker) |
| Options (A–D) | Numerals / lettered lines | Bordered accent tiles/pills, press-select, mint ✓ / coral ✗ |
| Timer | Gold bar / ring / pie / sweep / numeral | Flat **yellow** fill + black border + hard shadow, or Anton number-flex |
| Reveal | Green ✓ / red ✗ + marker marks | `mint` ✓ / `coral` ✗ badges + coral/ink lasso+arrow + Anton numerals |
| Title/hook | Bokeh + glow + shadowed title | Anton headline on block, eyebrow pill, boxed number, icon tile |
| Transitions | Doodle/word bumpers, wipes | Hard color-block slams, Anton word bumpers, easeOutCubic |
| Scoring | On-screen tally | Anton number-flex tier card + mint/coral recap |
| End card | Sub buttons + comment bait | Bordered Subscribe/Next + **parent-email gate** + watermark |
| Type | Condensed display + marker | **Anton** + **DM Sans**, UPPERCASE, tracked eyebrows |
| Palette | Cool navy + warm gold/red | ink/paper + blue/mint/coral/yellow/cream; one accent/frame |

---

## 12. Reusable production template

### 12.1 Timing budgets by pacing model
```
BASELINE (8–10 min, 7 puzzles)
0:00–0:15  Hook "X% fail" + title card
0:15–0:20  Bumper → Round 1
[×7] Round: ~5s question · ~7s countdown · ~2s suspense · ~6s reveal(green ✓) · ~5s explain · ~3s bumper
           (insert interlude/stat card after rounds 2,4,6)
last 0:20  Tiered score + parent-email CTA
last 0:08  End card (Subscribe/Next + watermark)

SLOW-DEEP (10–15 min, 15–20 items @ 30–45s)   FAST-LONG (15–30+ min, ~50 items @ 8–15s, themed Parts)
SHORT-FORM (9:16, 20–45s, 1 puzzle): 1–2s hook · question · number-flex timer · reveal · parent-email CTA
```

### 12.2 Per-round screen recipe (on-brand)
```
┌──────────────────────────────────────────────────────────┐  ← flat accent block (rotate per round)
│  [ EYEBROW PILL: RIDDLE 3 / 7 ]                            │
│      ┌───────────────────────────┐   ⟵ black border 4px   │
│      │      PUZZLE MEDIA         ◼│      + hard shadow 12px │
│      └───────────────────────────┘      radius 40px        │
│   ▓▓▓▓▓  QUESTION IN ANTON UPPERCASE?  ▓▓▓▓▓               │  ← bordered card / accent band
│   [A]blue  [B]mint  [C]coral  [D]yellow   ← option tiles (variant a) │
│   [ yellow ▮▮▮▮▮▯▯▯▯▯ ] countdown  (black border + shadow) │  ← timer, action-safe
└──────────────────────────────────────────────────────────┘
Reveal: mint ✓ on correct (coral ✗ on wrong) + coral lasso/arrow (variant b) + big Anton number.
```

### 12.3 Reusable component library (build once, reuse everywhere)
Mirror the web→video map (`DESIGN.md` §10): **Hook/title card** · **round bumper** · **puzzle
frame** (single & 2-up) · **question card/band** · **option tile/pill** (press + ✓/✗ states) ·
**countdown timer** (bar + number-flex + ring/pie/sweep variants) · **reveal kit** (lasso, arrow,
✓/✗ badges, big number) · **interlude/stat card** · **tiered score card** · **outro CTA + parent-
email gate + end screen** · **9:16 variants** of each.

### 12.4 Per-video checklist
- [ ] Pick **one format variant** (§2) + **polish tier**; pick a **pacing model** (§9).
- [ ] N **original**, varied, age-appropriate puzzles (§7); no reused riddles/art.
- [ ] Backbone in order (§3): hook → title → question(+options) → **visible timer** → **green ✓
      reveal** → one-line explain → **tiered score** → end screen.
- [ ] Consistent stage (rotating flat accent blocks; no gradients/glows).
- [ ] Every image in a black-bordered, hard-shadow frame; Anton UPPERCASE questions; DM Sans body.
- [ ] On-brand timer (flat yellow + black border, or Anton number-flex).
- [ ] Reveal uses **mint ✓ / coral ✗** + brand annotations (flat, zero blur).
- [ ] Bumpers = hard color-block slams; easeOutCubic; press 150 / enter 200 / reveal 300.
- [ ] **Parent-email gate CTA** + bordered Subscribe/Next end screen + 150×150 watermark.
- [ ] **Compliance checklist (§0) fully passed** (CARU cleared, zero child PII, no Alpha branding,
      prize rules public).
- [ ] Matching **thumbnail** (1280×720, ≤6 words, cap-height ≥90px) + **9:16 short** cut.
- [ ] Safe zones respected; **sRGB** export; shadows zero-blur; borders pure black.

### 12.5 Original example round (illustrative — write your own)
> **Round 4 / 7 (variant a).** Media: bordered photo panel of five mugs, one turned backwards.
> Band (yellow, ink Anton): **"WHICH MUG IS THE ODD ONE OUT?"** Options A–D as bordered blue/mint/
> coral/yellow tiles. Timer: yellow bar, ~6 s. Reveal: **mint ✓** presses onto tile C, **coral ✗**
> on the rest; big Anton **"C"**; one-line explanation. Bumper: coral block slam → Round 5.

---

## 13. Repurposing: short-form + carousel + blog (PRD)

One puzzle set → many surfaces. Keep the brand + the parent-email gate on every surface.

- **Short-form (9:16):** §9 cut-down; 1 puzzle, big number-flex timer, one parent-email CTA. Auto-
  spawn 3–6 Shorts per long-form.
- **Carousel (IG/LinkedIn, 1080×1350 or 1080×1080):** static brand slides —
  `Hook "X% fail" → Puzzle → "Answer on next slide" → Reveal (mint ✓) → Score tiers → parent-email
  CTA`. Each slide = a color block + Anton headline + bordered media/sticker. Same recipes as §12.2.
- **Blog:** embed the video, write an **original** write-up (puzzle setups + explanations in our
  words), add a **parent-email gate** CTA block and a link to **public prize rules**. Reuse thumbnail
  + card art as inline images.

---

## 14. What could NOT be determined from frames alone

- **Exact cut timings.** Sampling was 1 frame / 12 s → all durations are **±6 s estimates**, not
  frame-accurate; precise per-round countdown lengths and interlude counts aren't fully resolvable.
- **Named fonts.** Typefaces described **by class** only (condensed display; hand-drawn marker) —
  irrelevant since we standardize on **Anton + DM Sans**.
- **Audio design.** Music genre, SFX, VO cadence can't be read from frames; only inferred
  (VO + music bed + stingers).
- **Animation specifics.** Per-transition/timer curves aren't readable from stills — we substitute
  the brand motion spec (`DESIGN.md` §7).
- **Whether a real caption/subtitle track exists.** Visible text is graphic overlays
  (question/answer), not a confirmed transcript.
- **Batch-A/-B raw evidence.** Their note files were absent on disk; conclusions were folded in from
  the task brief. Re-drop `video/analysis/notes-batch-*.md` if additional supporting detail exists.
```
