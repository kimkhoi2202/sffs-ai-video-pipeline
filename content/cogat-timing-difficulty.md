# CogAT Timing & Difficulty Calibration — **Grade 5 / Level 11**

> Calibration spec that aligns each quiz question's **difficulty tier** and **countdown time** with
> the real CogAT (Cognitive Abilities Test) conventions, targeted at **CogAT Level 11 = Grade 5
> (~age 10–11)** and scaled for a punchy video format.
>
> **Target changed:** this doc was recalibrated from grades 6–8 (Levels 12–14) down to **Grade 5 /
> Level 11**. See §1.4 for exactly what changes at Level 11.
>
> **IP note:** Built from **general/public** information about how the CogAT is *structured, timed,
> and normed*. No proprietary CogAT items, copyrighted administration manuals, or exact timing
> tables are reproduced verbatim — facts are **summarized**, and the per-item timing model is **our
> own original derivation**. Our quiz questions remain original items written in the CogAT *style*.

---

## 1. Research summary — CogAT Level 11 (Grade 5)

### 1.1 Structure: 3 batteries × 3 subtests (9 formats)
Unchanged by level. The CogAT (Riverside Insights / Houghton Mifflin Harcourt; Lohman & Hagen)
measures three **batteries**, each with three **subtests**:

| Battery | Subtests | What it taps |
|---|---|---|
| **Verbal** | Verbal Analogies · Sentence Completion · Verbal Classification | Word relationships, inference, vocabulary |
| **Quantitative** | Number Analogies · Number Puzzles · Number Series | Numeric patterns & relations |
| **Nonverbal** | Figure Matrices · Paper Folding · Figure Classification | Spatial/figural reasoning with novel content |

### 1.2 Timing: power test, ~10 min/subtest (Level 11 specifics)
At Level 11 the test is **self-paced but time-limited**: **each of the 9 subtests is capped at
10 minutes**, total **90 minutes / 176 items**. It is a *power* test (reasoning depth), not a speed
test. Published Level-11 item counts give this approximate **per-item budget** (our derivation from
public counts — not a reproduced table):

| Subtest | Items (Level 11) | ≈ per-item budget |
|---|---|---|
| Verbal Analogies | 24 | ≈ 25 s |
| Sentence Completion | 20 | ≈ 30 s |
| Verbal Classification | 20 | ≈ 30 s |
| Number Analogies | 18 | ≈ 33 s |
| Number Series | 18 | ≈ 33 s |
| Number Puzzles | 16 | ≈ 38 s |
| Figure Matrices | 22 | ≈ 27 s |
| Figure Classification | 22 | ≈ 27 s |
| Paper Folding | 16 | ≈ 38 s |

**Honest nuance:** by raw count-budget, Level 11 packs **22** items into the 10-min Figure
Matrices/Classification subtests, so those figure formats get *~27 s* each — mid-pack, not longest.
The clear budget leaders are **Paper Folding** and **Number Puzzles** (~38 s). We still keep a
"figure items longest" ladder for the video (§2) on **cognitive-load grounds** (figural items shown
as on-screen icon sequences need the most visual parsing time) — this is a deliberate design choice,
noted openly, and is supported by response-time research (figural-matrix RT rises with rules/
transformations; paper-folding RT rises with folds).

### 1.3 Difficulty: normed to ~age 10–11
Level 11 is developmentally scaled for **Grade 5**. Items use fewer elements / fewer simultaneous
rules than the middle-school levels, and raw scores are normed against **same-age (10–11 yr) peers**
(USS → Standard Age Score, mean 100, SD 16). So "difficulty" here means **difficulty for a Grade-5
solver**.

### 1.4 How Level 11 differs from the grades 6–8 (Level 12–14) figures we used before
- **Same test *format* / time budget.** Levels 9–17/18 all run **10 min/subtest, 176 items, 90 min**.
  So the **CogAT-realistic per-item budget is essentially level-invariant** — our realistic
  baselines are basically unchanged from the middle-school pass. The Level-11 counts differ only
  trivially (e.g., Figure Matrices/Classification = 22 at Level 11).
- **What actually changes = item difficulty + norms.** Level-11 items carry **easier content** and
  are judged against **younger peers**. Consequences for us:
  1. **Difficulty tiers rise** for multi-step numeric patterns (an item that's "Medium" for grade 8
     is often "Hard" for grade 5): 2nd-difference series, Fibonacci-type series.
  2. **Two items use above-Grade-5 *concepts*** (squares, cubes → exponents are Grade 6+; see §4)
     and should be swapped for Grade-5 patterns.
  3. **Video countdowns skew a touch quicker** (§2) to match Level-11's lighter feel while keeping
     the ladder.

---

## 2. Battery → pacing rationale (ladder preserved, compressed for Level 11)

```
FAST  →→→  SLOW
Verbal (Analogy / Classification)  <  Sentence Completion / Quantitative (Series, Analogy, Puzzle)  <  Nonverbal Figure items
```

Two rules drive every recommended time:
1. **Battery/type sets the base** — verbal shortest, quantitative medium, nonverbal figure longest.
2. **Difficulty scales it** — harder items get proportionally more time.

**Timing model (our original derivation):**

| Type (Medium base) | CogAT-realistic (Level 11) | Video (Level 11) |
|---|---|---|
| Verbal Analogy | 25 s | 5 s |
| Verbal Classification | 28 s | 5 s |
| Sentence Completion | 30 s | 6 s |
| Number Series / Number Analogy | 33 s | 6 s |
| Number Puzzle | 38 s | 6 s (→7 s at Hard) |
| Figure (series/analogy/rotation/position) | 35 s | 7 s |

- **Realistic** difficulty multiplier: Easy ×0.85, Medium ×1.0, Hard ×1.2 (rounded).
- **Video** difficulty step: Easy −1 s, Medium 0, Hard +1 s; **floor 5 s, cap 8 s** (tighter than the
  middle-school cap of 10 s — this is the "a touch quicker" Level-11 adjustment).

---

## 3. Per-question calibration table (Grade 5 / Level 11)

Rounds map to files: **R2** = `cogat-style-round.md`, **R3** = `cogat-style-round-03.md`,
**R4** = `cogat-style-round-04.md`, **R5** = `cogat-style-round-05.md`.
⚠ = concept above Grade 5 → see §4 for the recommended swap.

| Round | Q# | Battery / Type | Grade-5 Difficulty | CogAT-realistic (L11) | **Video-rec (L11)** | (current in file) |
|:---:|:---:|---|:---:|:---:|:---:|:---:|
| R2 | Q1 | Verbal / Analogy (size-degree) | Medium | ~25 s | **5 s** | 6 s |
| R2 | Q2 | Verbal / Classification | Easy | ~24 s | **5 s** | 5 s |
| R2 | Q3 | Quantitative / Number Series (2nd differences) | **Hard** | ~40 s | **7 s** | 7 s |
| R2 | Q4 | Quantitative / Number Analogy (squares) | **Hard** ⚠ | ~40 s | **7 s** | 6 s |
| R2 | Q5 | Nonverbal / Figure Series (rotation) | Medium | ~35 s | **7 s** | 6 s |
| R3 | Q1 | Verbal / Analogy (tool-action) | Easy | ~21 s | **5 s** | 5 s |
| R3 | Q2 | Verbal / Sentence Completion | Medium | ~30 s | **6 s** | 6 s |
| R3 | Q3 | Quantitative / Number Series (doubling) | Easy | ~28 s | **5 s** | 5 s |
| R3 | Q4 | Quantitative / Number Analogy (halving) | Easy | ~28 s | **5 s** | 6 s |
| R3 | Q5 | Nonverbal / Figure Series (polygon sides) | Medium | ~35 s | **7 s** | 6 s |
| R4 | Q1 | Verbal / Classification (trees) | Easy | ~24 s | **5 s** | 5 s |
| R4 | Q2 | Verbal / Analogy (worker-tool) | Medium | ~25 s | **5 s** | 6 s |
| R4 | Q3 | Quantitative / Number Series (Fibonacci) | **Hard** | ~40 s | **7 s** | 7 s |
| R4 | Q4 | Quantitative / Number Puzzle (hidden op) | Hard | ~46 s | **7 s** | 8 s |
| R4 | Q5 | Nonverbal / Figure Analogy (empty→filled) | Easy | ~30 s | **6 s** | 5 s |
| R5 | Q1 | Verbal / Analogy (opposites) | Easy | ~21 s | **5 s** | 5 s |
| R5 | Q2 | Verbal / Classification (ops vs number) | Medium | ~28 s | **5 s** | 6 s |
| R5 | Q3 | Quantitative / Number Series (−8) | Easy | ~28 s | **5 s** | 6 s |
| R5 | Q4 | Quantitative / Number Analogy (cubes) | **Hard** ⚠ | ~40 s | **7 s** | 8 s |
| R5 | Q5 | Nonverbal / Figure Series (position track) | Medium | ~35 s | **7 s** | 7 s |

**Difficulty distribution (as written):** Easy 8 · Medium 7 · Hard 5. After the two §4 swaps (both
become Medium): **Easy 8 · Medium 9 · Hard 3** — a good Grade-5 mix (mostly accessible, a few honest
spikes in the multi-step number-series items).

**Re-leveling vs the middle-school pass:** three number items move **up to Hard for Grade 5** —
R2 Q3 (2nd-difference series), R4 Q3 (Fibonacci), and the two ⚠ analogy items — because multi-step
numeric patterns are genuinely harder for a 10–11-year-old. Verbal/figure tiers are unchanged.

---

## 4. Grade-5 flags & swaps (above Level 11)

Per Common Core, **whole-number exponents (squares/cubes) are a Grade 6 concept** (6.EE.A.1); Grade 5
exponents are limited to **powers of 10** (5.NBT.2), and squaring/cubing are commonly taught even
later. Two items rely on exponent recognition and are **out-of-level for Grade 5** — swap each for a
same-*type* (Number Analogy: "apply one consistent rule") pattern built from Grade-5 arithmetic:

| Item | Problem (why out-of-level) | Recommended Grade-5 swap (same type) | New difficulty | Realistic / Video |
|---|---|---|---|---|
| **R2 Q4** | `2→4, 3→9, 4→16, 5→?` = **squares** (n²; Grade 6+ concept) | **×3 rule:** `2→6, 3→9, 4→12, 5→?` → **15** · options 10 / 15✅ / 18 / 20 | Medium | ~33 s / **6 s** |
| **R5 Q4** | `2→8, 3→27, 4→64, 5→?` = **cubes** (n³; Grade 6–8 concept) | **×2 + 1 rule:** `2→5, 3→7, 4→9, 5→?` → **11** · options 10 / 11✅ / 12 / 13 | Medium | ~33 s / **6 s** |

- Both swaps keep the exact reasoning **type** (discover one consistent transformation and apply it),
  use only multiplication/addition (Grade 3–5 core), and preserve a real "figure-out-the-rule"
  challenge without any exponent knowledge.
- **Simpler fallbacks if desired:** R2 Q4 → keep ×3 (already easy-Medium); R5 Q4 → `×4` (`2→8, 3→12,
  4→16, 5→20`) for a single-rule Medium.
- If a swap is applied, use the **Medium** row above (realistic ~33 s, video **6 s**) instead of the
  ⚠ Hard row in §3.

*(Not flagged, though Hard for Grade 5: R2 Q3 2nd-difference series and R4 Q3 Fibonacci — these use
only addition, so the **concept** is grade-appropriate; they're just hard reasoning. R3 Q2's word
"reinforce" is upper-Grade-5 vocabulary but inferable from context. Keep as Hard/Medium.)*

---

## 5. Real-vs-video timing recommendation

- **Use the "Video-rec (L11)" column.** It compresses the real ~21–46 s/item Level-11 power-test
  pacing into a tight **5–8 s** on-screen band while keeping the CogAT ladder: verbal shortest
  (5 s), quantitative middle (5–7 s by difficulty), nonverbal figure longest (6–7 s).
- **Level 11 is a touch quicker than the middle-school set** (cap 8 s vs 10 s; figure items 7 s vs
  8 s; hard puzzle 7 s vs 10 s), reflecting Level 11's lighter feel — but the **ratios are intact**
  (figure ≥ quantitative ≥ verbal at equal difficulty).
- **Net changes vs the current file countdowns** (apply later — files are off-limits now):
  - R2: Q1 6→5, Q4 6→7, Q5 6→7
  - R3: Q4 6→5, Q5 6→7
  - R4: Q2 6→5, Q4 8→7, Q5 5→6
  - R5: Q2 6→5, Q3 6→5, Q4 8→7
  - (all other questions already match)
- **Why not the realistic times?** The real ~21–46 s budgets are correct for the actual test but kill
  on-screen momentum. Keeping the *ratios* preserves the CogAT feel; the compression is a video choice.

---

## 6. How to apply

1. **Adopt the Video-rec (L11) countdowns** and the two §4 swaps in a future content pass. Renders
   are running concurrently, so this doc **does not edit** the round files — treat the last two table
   columns + §4 as the diff to apply when safe.
2. **Keep the ladder for new items:** pick the type base (§2), apply the difficulty step (Easy −1 s /
   Hard +1 s), floor 5 s, cap 8 s. New figure item → 7 s; new verbal → 5 s; new number series/analogy
   → 6 s.
3. **Difficulty = Grade-5 lens (age 10–11):** rate by (a) number of reasoning steps, (b) familiarity
   of the rule *at Grade 5*, (c) distractor pull. Single familiar rule = Easy; one non-obvious rule =
   Medium; multi-step pattern / novel format / hidden rule = Hard. **Reject any item needing a
   Grade-6+ concept** (exponents/squares/cubes, negative numbers, ratios) — swap for a Grade-5 rule of
   the same type.
4. **Stay IP-safe:** original CogAT-*style* items only; never paste real CogAT items or published
   timing tables.

---

## 7. Sources (public / general info)

**Level 11 / Grade 5 structure, item counts, timing (176 items, 90 min, 10 min/subtest):**
- Riverside Insights — testing time, items per subtest, completion criteria (Levels 9–17/18 = 10
  min/subtest): https://support.riversideinsights.com/support/solutions/articles/70000585558-cogat-testing-time-number-of-items-per-subtest-and-completion-criteria-
- GiftedReady — CogAT Grade 5 (Level 11) format & subtest counts: https://www.giftedready.com/cogat/grade-5-free-practice-test/
- SkilledChildren — CogAT Grade 5 (Level 11) counts & 90-min timing: https://skilledchildren.com/cogat-test/cogat-test-grade-5/
- CogAT Product Guide (Form 7) — fixed 10-min/subtest for Levels 9+: https://www.aacs.org/wp-content/uploads/2012/10/CogAT-Product-Guide-Form-7.pdf

**Difficulty scaling / norms:**
- CogAT overview (difficulty developmentally scaled by level) — Riverside Insights: https://riversideinsights.com/hubfs/CogAT/CogAT%20Overview%20Brochure.pdf
- Score scaling (USS → SAS, age norms) — Riverside score types: https://onlinehelp.riversideinsights.com/Help/Elevate/Topics/015_Interpreting_Scores/Types_of_Scores.htm

**Grade-level concept boundaries (why squares/cubes are above Grade 5):**
- CCSS 5.NBT.2 — Grade 5 exponents limited to **powers of 10** (Grade 5 standards overview): https://math.libretexts.org/Courses/Coalinga_College/Math_for_Educators_(MATH_010A_and_010B_CID120)/01%3A_Teaching_Elementary_Mathematics/1.04%3A_Common_Core_Standards_for_Mathematics/1.4.06%3A_Grade_5_Standards_Overview
- CCSS 6.EE.A.1 — **Grade 6** introduces whole-number exponents; perfect squares/cubes via area/
  volume models: https://ospi.k12.wa.us/sites/default/files/2022-12/mathstandards_grade6.pdf

**Why figural/spatial items carry the most per-item load (video ladder rationale):**
- Figural-matrix response time vs cognitive load — *J. Intelligence* 2016: https://www.mdpi.com/2079-3200/4/3/11
- Mental paper-folding RT rises with folds/direction changes — PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC11905326/

*Times and difficulty tiers here are our own calibration derived from the general facts above; they
are not reproductions of any proprietary CogAT material.*
