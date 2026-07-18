# Kid Loop — Video Production Brief (Content)

The **content brief** that turns the marketing PRD's **"Kid Loop"** into a repeatable video
pipeline. It sits between the strategy (the PRD) and the craft docs:

- **Format/craft** → `video/riddle-video-style-spec.md` (canonical style & format spec)
- **Brand/visual** → `DESIGN.md` + `design-reference/design-tokens.md` (neo-brutalist system)
- **Puzzles** → `video/content/starter-quiz-bank.md`
- **Scripts** → `video/templates/script-template.md`
- **Boards/shots** → `video/templates/storyboard-shotlist.md`

> **What this is:** the objective, audience, funnel, cadence, format menu, brand rules, compliance,
> prize, and a per-video Definition of Done for the Kid Loop.
> **What this is NOT:** a style tutorial (see the spec) or a strategy doc (see the PRD). All puzzles
> and copy we ship are **original** — we never reproduce riddles, answers, or assets from any source
> video.

> **Sourcing note:** the marketing PRD is the parent document for the Kid Loop, its prize mechanic,
> and the COPPA-safe parent-capture requirement. Where the PRD is not checked into this repo, its
> relevant decisions are restated here and in the spec's §0 so the pipeline is self-contained. If the
> PRD changes, update §1, §5, and §8 here to match.

---

## 1. Objective

Build a **top-of-funnel audience engine** of Bright Side–style brain-teaser videos ("Smart Fella")
whose **single job** is to move a kid to a **results gate that captures a PARENT'S email** — then
hand that parent to the landing page and the prize mechanic. Every video is a **funnel**, not just
entertainment.

- **Primary metric:** parent-email captures per 1,000 views (gate conversion).
- **Secondary:** view-through / average % viewed, Shorts→long-form click, carousel saves/shares,
  blog→gate clicks, comment rate ("I got 8/10").
- **Guardrail metric:** **100% CARU pass rate** and **zero child-PII incidents** (a hard gate — a
  video that fails compliance has *negative* value regardless of views).

---

## 2. Target audience

| | Who | Notes |
|---|---|---|
| **On-screen viewer** | Kids ~**6–12** | Puzzles solvable in seconds from one screen; playful, non-shaming tone; age-appropriate difficulty (see quiz-bank tiers). |
| **Captured contact** | The kid's **parent/guardian** | The **only** person we collect data from. The CTA is always a *parent* action. |
| **Buyer / decision-maker** | Parent | Prize framing, nurture, and all follow-up are **parent-facing**. |

We build for the kid's attention and the **parent's inbox**. The child is never a data subject.

---

## 3. The funnel

```
   VIDEO (long-form / Short / carousel / blog)
     │  hook → rounds → score → "want your results?"
     ▼
   RESULTS GATE  ── "Ask a parent to enter their email to unlock your results."
     │  collects PARENT EMAIL ONLY. zero child PII. links to public prize rules.
     ▼
   LANDING PAGE  ── results + parent-facing prize explainer + public rules link
     │
     ▼
   PARENT NURTURE  ── email; enters the prize mechanic (input-tier + spotlight)
```

- **The one CTA per surface** is the **parent-email gate** (§ spec 0, 11.10). No competing asks.
- The **video never contains data-collection UI** — it only points to the gate.
- The gate collects a **parent email address and nothing else at entry** (no child name, age,
  birthday, school, location, photo, voice, or device/persistent ID — anywhere in the flow).
- Any on-screen prize mention links to **public, parent-facing rules**.

---

## 4. Cadence & ramp

Ramp to **~3 rounds per week by week 4**. A **"round"** = one puzzle set produced once and shipped
across all surfaces (**1 long-form + its Shorts + 1 carousel + 1 blog**).

| Week | Rounds / wk | Focus | Output per round |
|---|---|---|---|
| 1 | **1** (pilot) | Stand up the pipeline; ship 1 lean MC quiz-board; get CARU sign-off on the template. | 1 long-form + 3 Shorts + 1 carousel + 1 blog |
| 2 | **1–2** | Add variant (b) open-riddle; test hooks & thumbnails; tighten the gate. | same |
| 3 | **2** | Lock the reusable component library; batch puzzle writing; parallelize edit. | same |
| 4 | **~3** | Steady state; introduce a premium variant (c) flagship for the spotlight tier. | same |

> Batch upstream (puzzle writing, CARU review, VO) so the weekly bottleneck is edit/publish, not
> content. One round should spawn **3–6 Shorts** (spec §9, §13).

---

## 5. Format menu (choose per round)

Pick **one variant × one polish tier × one pacing model**, then ship the surface set. Full detail in
spec §2, §8, §9, §13.

**Variant (reveal grammar — don't blend):**

| Variant | Look | Best for | Default polish |
|---|---|---|---|
| **(a) MC quiz-board** | question banner + A–D option tiles + timer + ✓/✗ | trivia/knowledge, mass volume, most shareable ("I got 8/10"), easiest CARU | **lean** |
| **(b) Open riddle** | media/prompt + timer + annotated reveal (lasso/arrow) | optical/spot-the-difference/lateral, "aha", pause-and-solve | **standard** |
| **(c) Animated narrative** | short story scene poses the riddle; scripted "think" beat | flagship logic/story riddles, rewatch, **spotlight tier** | **premium 4K** |

**Polish tier:** `lean/flat` (volume, 1080p) → `standard` (motion gfx, 1080p) → `premium 4K`
(full animation, VO talent) — see spec §2.

**Pacing model:** `baseline` (~8–10 min, 7 puzzles) · `slow-deep` (10–15 min, 15–20) · `fast-long`
(15–30+ min, ~50 in themed Parts) · `short-form 9:16` (20–45 s, 1 puzzle) — see spec §9.

**Surfaces (ship all four per round):** long-form (16:9) · Shorts (9:16, 3–6) · carousel
(1080×1350 / 1080×1080) · blog (embed + original write-up). Every surface keeps the brand **and** the
parent-email gate (spec §13).

**Default pilot recipe:** variant **(a)** + **lean** + **baseline** (7 rounds) — cheapest to
template, most shareable, easiest to keep CARU-safe.

---

## 6. Brand rules

**Channel identity:** **Smart Fella** — a playful, kid-first brain-teaser channel. The wordmark
leans on the friendly spoonerism ("Smart Fella") as its in-joke; keep it light and tasteful, never
crude. **Neutral brand only** — carries **no Alpha School / Alpha AI** names, logos, mascots, colors,
or URLs, and never implies school affiliation (spec §0).

**Host voice (the on-screen/VO persona):** an upbeat **game-show host** — warm, high-energy,
encouraging, a little cheeky; celebrates the viewer, never mocks a wrong answer. Delivered by the
ElevenLabs host voice (see `video/templates/script-template.md`).

**Visual system (the "Closer" neo-brutalist look — 4 non-negotiable signatures, `DESIGN.md` §0):**
1. **Thick pure-black outlines** on every object.
2. **Hard offset shadows — ZERO blur** (the #1 signature).
3. **Anton UPPERCASE** display + **DM Sans** body.
4. **Flat bright color-blocking** — one dominant accent per frame.

**Palette:** `ink #000` · `paper #fff` · `blue #839AFF` · `mint #C6FCD0` · `coral #FD7962` ·
`yellow #FCE552` · `cream #F6F4EE`. **Reveal coding: mint ✓ = correct, coral ✗ = wrong.** Timer =
flat **yellow** fill + black border + hard shadow (or Anton number-flex). 1080p pixel scale: border
4px, card shadow 12px, radius 40px, all shadows 45° pure black (`DESIGN.md` §4).

**Non-shaming tier language** (viewer-facing): puzzle tiers **Warm-Up / Brain-Bender / Big-Brain**;
score tiers **Rookie Riddler / Sharp Cookie / Certified Smart Fella** (encouraging, never "dumb/
genius" shaming).

---

## 7. Outputs & repurposing (per round)

One puzzle set → many surfaces (spec §13). Definition-of-Done covers all of these.

- **Long-form (16:9):** the master cut (variant + pacing per §5).
- **Shorts (9:16):** 3–6 cut-downs; 1 puzzle each; big Anton number-flex timer; **one** parent-email
  CTA; hook in the first 1–2 s.
- **Carousel (1080×1350 or 1080×1080):** `Hook → Puzzle → "Answer next slide" → Reveal (mint ✓) →
  Score tiers → parent-email CTA`.
- **Blog:** embed the video + an **original** write-up (setups + explanations in our words) + a
  parent-email gate block + link to **public prize rules**; reuse thumbnail/card art inline.
- **Thumbnail (1280×720):** ≤6 words, cap-height ≥90px, passes the 168×94 legibility test.

---

## 8. Compliance summary (COPPA / CARU) — hard gate

Compliance is a **hard gate, not a nice-to-have** (spec §0). If a concept can't satisfy **every**
rule, it does not ship.

- **Parent-email capture only.** CTA is a plainly-worded **parent** action, e.g. *"Ask a parent to
  enter their email to unlock your results."*
- **Zero child PII.** No name, age, birthday, school, location, photo, voice, device ID, or
  persistent identifier from the child — anywhere (video, gate, or follow-up).
- **CARU-reviewed.** Every script, on-screen claim, prize framing, and the gate flow **pass CARU
  before publishing**. Truthful, age-appropriate, non-manipulative (no fake scarcity, no dark
  patterns, no "tell your friends or lose your prize").
- **No Alpha branding.** No Alpha School / Alpha AI names, logos, colors, URLs, or implied
  affiliation.
- **Prize rules public.** $500 input-tier and $2,000 spotlight rules, eligibility, selection/odds,
  and winner terms **publicly posted** and linked from the gate; prize copy is parent-facing.

**Per-video compliance checklist (must all be true before publish):**

- [ ] CTA is a **parent-email** action, plainly worded; **no child data requested on-screen**.
- [ ] **No child PII** anywhere in the funnel; gate collects **parent email only**.
- [ ] Script + claims + prize framing + gate **submitted to CARU and cleared**.
- [ ] **No Alpha School / Alpha AI** branding, names, or affiliations.
- [ ] Prize tiers ($500 input / $2,000 spotlight) shown **with a link to public rules**.
- [ ] No dark patterns, no false urgency; age-appropriate difficulty and tone.

---

## 9. Prize summary (public, parent-facing)

Two-tier mechanic the funnel supports (spec §0). All prize communication is **parent-facing** and
links to **public rules**.

| Tier | Reward | Role in the loop |
|---|---|---|
| **Input tier** | **$500** | Broad-access reward for qualifying **parent** entries — keeps the top of the funnel active. |
| **Spotlight** | **$2,000** | Flagship reward; pairs naturally with a **premium variant (c)** round. |

**On-screen/prize rules:** rules, eligibility, selection method/odds, and winner terms are
**publicly posted** and linked from the gate and any on-screen prize mention (lower-third URL / end
card). Prize copy must clear CARU and never pressure the child (no "ask your friends," no countdown-
to-lose framing).

---

## 10. Definition of Done (per video)

A round ships only when **all** boxes are checked. (Combines spec §12.4 + `DESIGN.md` §14 + the
funnel/compliance requirements above.)

**Content & structure**
- [ ] One **variant** (§5) + polish tier + pacing model chosen.
- [ ] N **original**, varied, age-appropriate puzzles from the bank (no reused riddles/art).
- [ ] Backbone in order (spec §3): hook → title → question(+options) → **visible timer** →
      **mint ✓ reveal** → one-line explanation → **tiered score** → end screen.
- [ ] Script written from `script-template.md`; storyboard/shot-list from `storyboard-shotlist.md`.

**Brand & craft**
- [ ] Rotating flat accent stage blocks (no gradients/glows); one accent per frame.
- [ ] Every image in a black-bordered, hard-shadow frame; **Anton UPPERCASE** questions; DM Sans body.
- [ ] On-brand timer (flat yellow + black border, or Anton number-flex).
- [ ] Reveal uses **mint ✓ / coral ✗** + brand annotations (flat, zero blur).
- [ ] Bumpers = hard color-block slams; easeOutCubic; press 150 / enter 200 / reveal 300 ms.
- [ ] Safe zones respected; **sRGB** export; shadows zero-blur; borders pure black.

**Funnel & assets**
- [ ] **Parent-email gate CTA** + bordered Subscribe/Next end screen + 150×150 watermark.
- [ ] Matching **thumbnail** (1280×720, ≤6 words, cap-height ≥90px) that passes 168×94.
- [ ] Repurposing shipped: **3–6 Shorts + 1 carousel + 1 blog**, each with the gate (§7).

**Compliance (hard gate — §8)**
- [ ] Full **§8 compliance checklist passed**: CARU cleared, zero child PII, no Alpha branding,
      prize rules public.

---

## 11. File map (Kid Loop content system)

```
video/
├─ production-brief.md            ← you are here (PRD → pipeline bridge)
├─ riddle-video-style-spec.md     ← canonical style & format spec
├─ content/
│  └─ starter-quiz-bank.md        ← 24+ original puzzles + "generate more" guide
└─ templates/
   ├─ script-template.md          ← host VO script template + example round
   └─ storyboard-shotlist.md      ← per-round storyboard + shot-list + filled example
DESIGN.md · design-reference/design-tokens.md   ← brand / visual source of truth
```
