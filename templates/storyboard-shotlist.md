# Storyboard + Shot-List Template — Per Round

A reusable **storyboard** (beat → frame) and **shot-list** (every asset needed) for one Kid Loop
round. Each beat maps to the on-screen elements in the style spec (`../riddle-video-style-spec.md`
§6, §11) and the brand pixel scale (`DESIGN.md` §4). Keep it 1:1 with the VO in
`script-template.md`.

> **Pairs with:** `script-template.md` (VO beats, same round numbers) · `../content/starter-quiz-bank.md`
> (puzzle + art notes) · `DESIGN.md` (borders/shadows/type/motion) · `../production-brief.md`
> (funnel/compliance). **Compliance:** no data-collection UI appears **inside** the video; the
> parent-email gate is an **outro** card only (spec §0).

---

## 1. On-screen element legend (build once, reuse — spec §12.3)

All objects = **flat fill + pure-black border (4px) + hard offset shadow (zero blur, 45°) + rounded
(40px)**; one dominant accent per frame; rotate the stage color each round (`DESIGN.md` §4).

| Key | Element | Brand spec (1080p) |
|---|---|---|
| **BG** | Stage background | Flat accent color-block; rotate per round (blue→cream→ink→coral→mint→yellow→…). No gradient/glow. |
| **PILL** | Round eyebrow ("RIDDLE 3 / 7") | DM Sans 800 UPPER, +8% track, in a bordered pill; hard shadow. |
| **FRAME** | Puzzle media panel ("sticker frame") | Black border 4px + hard shadow 12–16px, radius 40px. 2-up = two panels + 8–12px black divider. |
| **Q-CARD** | Question card / band | Ink card + paper text, or accent band + ink text; **Anton UPPERCASE** 64–90px; docked top/bottom; ≤ ~8 words. |
| **TILE A–D** | Option tiles/pills (variant a) | Bordered accent tiles, one color each (blue/mint/coral/yellow), ink text; **press** to select. |
| **TIMER** | Countdown | Flat **yellow** fill + black border + hard shadow bar (bottom/left) **OR** Anton number-flex box. Action-safe. |
| **✓ / ✗** | Reveal badges | **mint ✓** = correct, **coral ✗** = wrong; pop/press in. |
| **MARKS** | Reveal annotations (variant b) | Coral/ink **lasso + arrow** stickers (bordered, hard shadow); flat, zero blur. |
| **NUM** | Big answer / count | Anton numeral/word, presses in (Recipe B "number flex"). |
| **SCORE** | Running score chip | Small bordered pill/card; ticks up; mint/coral recap dots. |
| **LOWER-3** | Lower-third (optional) | Bottom-left, title-safe; Anton name + DM Sans role. |
| **WM** | Watermark | 150×150 bordered mark, bottom-right; keep ~120×60 corner clear. |
| **CTA** | Parent-email gate card (outro) | Ink card + accent band, Anton UPPER — **parent action** wording; + prize pill linking public rules. |
| **END** | End screen | Bordered Subscribe / Watch-next / Playlist cards on one accent block, ~60px margins. |

**Per-round frame recipe** (spec §12.2):
```
┌──────────────────────────────────────────────┐  ← BG: flat accent (rotate per round)
│ [ PILL: RIDDLE n / N ]                         │
│        ┌───────────────────────┐ ◼ hard shadow │
│        │      FRAME (media)     │               │
│        └───────────────────────┘               │
│   ▓▓  Q-CARD: ANTON UPPERCASE?  ▓▓             │
│   [A]blue [B]mint [C]coral [D]yellow   (var a)  │
│   [ yellow ▮▮▮▮▮▯▯▯▯▯ ] TIMER   (action-safe)   │
│                                          WM ◻   │
└──────────────────────────────────────────────┘
Reveal: mint ✓ (coral ✗) + MARKS (var b) + big NUM.
```

---

## 2. Storyboard template (per round — copy this table)

Fill one row per beat; keep beats/durations in step with the VO script. Motion defaults:
`easeOutCubic`; **press 150 / enter 200 / reveal 300 ms** (`DESIGN.md` §7).

```
Round {{n}} / {{N}} · Variant {{a|b|c}} · Puzzle {{Q#}} · Stage color {{accent}} · Target {{~35–45s}}
```

| Beat | Dur | Frame (what we see) | On-screen elements | Motion / transition | VO ref | SFX / Music |
|---|---|---|---|---|---|---|
| Bumper in | ~1 s | Color-block wipe to new stage | BG swap, PILL enters | color-block slam; PILL enter 200ms | "Next one's…" | slam |
| Setup | ~2 s | Empty FRAME waiting | BG, PILL, FRAME | FRAME enter 200ms | SETUP line | thock |
| Question | ~4 s | Q-CARD over/!under FRAME | Q-CARD (Anton) | card enter 200ms | QUESTION read | — |
| Options *(a)* | ~3 s | 4 tiles appear | TILE A–D | staggered enter | OPTIONS line | ticks |
| Countdown | {{s}} s | Timer draining | TIMER (yellow) | bar drain easeOutCubic | `[COUNTDOWN {{s}}s]` | rising tick |
| Suspense | ~2 s | Hold on puzzle | dim/scale hint | subtle | "……" | sting |
| Reveal | ~3 s | Answer shown | ✓/✗, NUM, MARKS *(b)* / tile press *(a)* | reveal 300ms; press 150ms | REVEAL line | ding + slam |
| Explain | ~4 s | Answer + one-line | small caption band | caption enter | EXPLAIN line | — |
| Score | ~2 s | Score chip updates | SCORE | number tick | SCORE patter | ding |
| Bumper out | ~1 s | Wipe to next | BG→next color | color-block slam | "Next…" | slam |

**Non-round frames** (once per video — spec §5): **Hook/"X% fail" card** · **Title/promise card** ·
**Interlude/stat card** (after rounds 2/4/6) · **Tiered score card** · **Parent-email CTA + prize
pill** · **End screen + watermark**. Storyboard each as a single frame using the §1 elements; keep
the **CTA parent-worded** and prize linking public rules.

---

## 3. Shot-list / asset checklist (per round)

Every graphic asset the editor needs for the round (build from the reusable library, spec §12.3):

- [ ] **BG** color-block ({{accent}}) — full 1920×1080, sRGB.
- [ ] **PILL** "RIDDLE {{n}} / {{N}}".
- [ ] **FRAME** — puzzle media (setup state) + **reveal state** (answer/annotated). 2-up divider if comparison.
- [ ] **Q-CARD** — Anton question ({{≤8 words}}).
- [ ] **TILE A–D** *(variant a only)* — 4 option tiles, one accent each, + pressed/✓/✗ states.
- [ ] **TIMER** — yellow bar (or number-flex) for {{s}}s.
- [ ] **Reveal kit** — mint ✓ / coral ✗ badge; **MARKS** (lasso/arrow) *(variant b)*; big **NUM**.
- [ ] **SCORE** chip state for this round.
- [ ] **SFX** — thock, rising tick, ding, slam; **MUSIC** cues (bed up / duck / sting).
- [ ] Safe zones OK (title-safe 96px / action-safe 10%; timer clear of lower-third; WM corner clear).

---

## 4. Filled EXAMPLE — Round 3 / 7 (Q2 "Keys but no locks")

Matches the script example: **variant (b) open riddle · Brain-Bender · 8 s · stage = BLUE**
(`../content/starter-quiz-bank.md` Q2; `script-template.md` §4).

```
Round 3 / 7 · Variant (b) · Puzzle Q2 · Stage color BLUE · Target ~40s
```

| Beat | Dur | Frame (what we see) | On-screen elements | Motion / transition | VO ref | SFX / Music |
|---|---|---|---|---|---|---|
| Bumper in | 1 s | Wipe MINT→**BLUE**, "ROUND 3" | BG blue, PILL "RIDDLE 3 / 7" | color-block slam; PILL enter | "Round three…" | slam |
| Setup | 2 s | Empty sticker FRAME, centered | BG, PILL, FRAME (empty) | FRAME enter 200ms | "…trips up the grown-ups." | thock |
| Question | 4 s | Ink Q-CARD over frame | Q-CARD (Anton): "KEYS BUT NO LOCKS?" | card enter 200ms | "I have KEYS… but no locks…" | music bed |
| Countdown | 8 s | Yellow TIMER draining, bottom-center | TIMER bar (yellow/border/shadow) | bar drain easeOutCubic | "Clock's on… [COUNTDOWN 8s]" | rising tick |
| Suspense | 2 s | Hold; frame nudges/scales | slight zoom on frame | subtle | "……" | sting |
| Reveal | 3 s | FRAME slams to a **keyboard** image | mint **✓** pops; big Anton **"KEYBOARD"** (NUM) | frame slam (reveal 300ms); ✓ press 150ms | "It's a… KEYBOARD!" | ding + slam |
| Explain | 4 s | Keyboard + caption band | caption: "keys · space bar · letters" | caption enter 200ms | "…just not the everyday kind." | — |
| Score | 2 s | Score chip 2→3-ish | SCORE chip ticks | number tick | "That's three down, four to go." | ding |
| Bumper out | 1 s | Wipe BLUE→**CORAL**, "ROUND 4" | BG→coral | color-block slam | "Next one… is my FAVORITE." | slam |

**Shot-list for this round:**
- [ ] BG **blue** color-block (1920×1080).
- [ ] PILL "RIDDLE 3 / 7".
- [ ] FRAME — **setup:** empty bordered sticker frame; **reveal:** keyboard image in same frame.
- [ ] Q-CARD — Anton "KEYS BUT NO LOCKS?" (ink card, paper text).
- [ ] TIMER — yellow bar, 8 s, bottom-center (action-safe).
- [ ] Reveal kit — mint ✓ badge + Anton "KEYBOARD" number-flex. *(No option tiles — variant b.)*
- [ ] Caption band — "keys · space bar · letters."
- [ ] SCORE chip (round-3 state).
- [ ] SFX: thock, rising tick, ding, slam. MUSIC: bed up → duck → sting.
- [ ] Safe zones OK; WM bottom-right; corner clear.

---

## 5. 9:16 Shorts adaptation (spec §9, §13)

For a Short, storyboard **one** puzzle vertical (1080×1920): **stack** elements — PILL/hook top,
FRAME center, **Anton number-flex TIMER** (big, glanceable), reveal, then **one** parent-email CTA
card. Hook in the **first 1–2 s**. Same brand objects, enlarged type, tighter loop. Auto-spawn 3–6
Shorts per long-form.

---

## 6. Reminders (per spec §11.11 / `DESIGN.md` §12)

- Title-safe **96px** / action-safe **10%**; keep bottom-right **~120×60px** clear (duration stamp).
- Every image in a **black-bordered, hard-shadow** frame; **Anton UPPERCASE** questions; DM Sans body.
- **mint ✓ / coral ✗** reveals; **flat, zero-blur** shadows; **pure-black** borders.
- Export **sRGB (Rec.709)**, 1080p (4K for premium variant c) H.264 MP4.
- **Compliance:** outro CTA is a **parent** action; prize pill links **public rules**; no child-data
  UI inside the video; no Alpha branding.
