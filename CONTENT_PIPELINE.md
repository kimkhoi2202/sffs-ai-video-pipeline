# CONTENT_PIPELINE.md — Mass-Generating "Smart Fella or Fart Smella" Quiz Rounds

> **What this is.** The source-of-truth **playbook + spec** for producing quiz **content** at scale
> for the "Smart Fella or Fart Smella" (SFFS) CogAT-style quiz videos: how a round of 15 questions is
> structured, the exact JSON contract a generated round must satisfy, the authoring rules, the AI
> generation prompt, the automated validation pass (including a **persistent master question bank**
> for global de-duplication), and the mass-generation plan to reach ~100 rounds.
>
> **What this is NOT.** It is not the render/design system itself (that is [`../DESIGN.md`](../DESIGN.md)
> + [`README.md`](README.md)) and it does not re-derive the Remotion components — those are being
> actively repurposed in a parallel build, so this doc treats their **current data contract** as the
> stable interface and flags anything in flux.
>
> **Scope guard — the 5 render kinds.** The current Remotion renderer draws exactly **five plate
> kinds** (`text`, `numseries`, `shaded`, `polygon`, `dot` — see §1). Mass-generation targets **only
> these five** because they need **zero bespoke art**: every question is either text or a
> code-drawn figure. Riddles, trivia, spot-the-difference, optical illusions, etc. (which live in
> [`content/starter-quiz-bank.md`](content/starter-quiz-bank.md)) are **out of scope** for the
> automated pipeline until a matching renderer exists (see §13 Open questions).

**Related docs (read alongside):**
- [`README.md`](README.md) — pipeline overview (remotion / voice / renders), workflow, non-negotiables.
- [`../DESIGN.md`](../DESIGN.md) — brand + video design system (the four signatures, exact hexes/fonts).
- [`content/cogat-timing-difficulty.md`](content/cogat-timing-difficulty.md) — Grade-5 / Level-11 difficulty + countdown calibration (authoritative for timing).
- [`content/starter-quiz-bank.md`](content/starter-quiz-bank.md) — the original-puzzle "generate more" recipe + QA checklist.
- [`content/cogat-round-15.md`](content/cogat-round-15.md) — the curated 15-item reference round (human-readable).
- `remotion/src/data/questions.ts` + `remotion/src/data/types.ts` — the real, live question data + TypeScript contract this schema mirrors.

---

## Table of contents

1. [Question kinds & tiers (the taxonomy)](#1-question-kinds--tiers-the-taxonomy)
2. [Question-type templates](#2-question-type-templates)
3. [The round JSON schema (the contract)](#3-the-round-json-schema-the-contract)
4. [The master question bank (global de-duplication)](#4-the-master-question-bank-global-de-duplication)
5. [Authoring guidelines](#5-authoring-guidelines)
6. [Design system summary](#6-design-system-summary)
7. [Narration / VO contract](#7-narration--vo-contract)
8. [AI generation approach](#8-ai-generation-approach)
9. [Automated validation pass](#9-automated-validation-pass)
10. [Pipeline flow (high level)](#10-pipeline-flow-high-level)
11. [Mass-generation plan](#11-mass-generation-plan)
12. [Folder & naming conventions](#12-folder--naming-conventions)
13. [Open questions for the user](#13-open-questions-for-the-user)

---

## 1. Question kinds & tiers (the taxonomy)

Every question has **three** classifiers. Get all three right and it renders + files correctly.

- **`kind`** — the **renderer** that draws the plate. Exactly **5**, from the `Question` union in
  `remotion/src/data/types.ts`: `text`, `numseries`, `shaded`, `polygon`, `dot`.
- **`category`** — the **CogAT battery** (metadata for balance + `info.md`): `verbal`,
  `quantitative`, `nonverbal`. (In the live code this currently lives in `remotion/src/data/cuts.ts`
  as the `COG` map; the content schema folds it into each question — see §3.)
- **`tier`** — the **on-screen topic label** shown in the header pill (e.g. `NUMBER SERIES`). Short,
  UPPERCASE.

The **9 tiers in use** map onto the 5 kinds and 3 categories like this:

| # | Tier (on-screen) | `kind` | `category` | What it tests |
|---|---|---|---|---|
| 1 | `ODD ONE OUT` | `text` | verbal | Verbal classification — pick the member that breaks the set |
| 2 | `VERBAL ANALOGY` | `text` | verbal | A:B :: C:? word relationship |
| 3 | `SENTENCE COMPLETION` | `text` | verbal | Fill the blank from context |
| 4 | `NUMBER SERIES` | `numseries` | quantitative | Next term in a numeric sequence |
| 5 | `NUMBER ANALOGY` | `text` | quantitative | Apply one consistent rule: `a -> b` mapping |
| 6 | `NUMBER PUZZLE` | `text` | quantitative | A hidden-rule / "sneaky operator" puzzle |
| 7 | `FIGURE ANALOGY` | `shaded` | nonverbal | Empty:filled :: empty:? on circle/square/triangle |
| 8 | `FIGURE SERIES` | `polygon` | nonverbal | Growing/shrinking polygon by side count |
| 9 | `POSITION` | `dot` | nonverbal | A dot stepping around a square's corners |

**Key nuance:** the `text` kind is a **catch-all text plate** that powers **five** tiers
(odd-one-out, verbal analogy, sentence completion, number analogy, number puzzle). The other four
kinds are one-tier each. So "what data fields do I fill?" is decided by **`kind`**, and "how do I
write the item?" is decided by **`tier`**.

**Canonical round mix** (mirrors the live 15-item master): **verbal 6 · quantitative 6 · nonverbal 3**,
where the 3 nonverbal are **one of each** visual kind (`shaded`, `polygon`, `dot`) so all three
figure renderers get exercised and stay varied. See §5.6 for the full balance target.

---

## 2. Question-type templates

For each kind: **structure**, **data fields**, a **worked example** (real, from
`remotion/src/data/questions.ts`), and **authoring rules**. Field names match the live TypeScript
types verbatim.

> **Fields on EVERY question** (the `Common` shape): `id` (play position 1..15), `kind`, `category`,
> `tier`, `difficulty`, `countdown` (seconds), `ansLetter` (`A`|`B`|`C`|`D`), `ansLabel` (UPPERCASE
> answer shown on the reveal card), `explanation` (one to two sentences, sentence case).
>
> **You do NOT author colors or durations.** Plate colors are computed by the renderer from `id`
> (see §6.3); narration durations (`qDur`/`rDur`) are measured from the generated audio (see §7).
> The legacy `bg`/`tierColor`/`accent` fields still present on the `questions.ts` type are **not read**
> by the current components — omit them.

### 2.1 `text` — verbal & number-word plate

The workhorse. One centered white prompt box (Anton, UPPERCASE) + a 2×2 grid of A/B/C/D text option
cards. Powers 5 tiers.

**Fields**
- `question` (string) — the prompt. Supports:
  - `\n` = a hard line break (control line wrapping yourself).
  - `->` = renders as a real vector **arrow** (used for `a -> b` mappings in NUMBER ANALOGY).
  - Math operators `+ = × ÷ −` render as crisp SVG glyphs (used in NUMBER PUZZLE). Prefer plain
    ASCII `+` and `=`; the renderer spaces them evenly. (Ordinary hyphens inside words are left alone.)
- `questionFontSize` (int) — tuned to the text length so it fits without overflow. Guide:

  | Prompt shape | Example tier | `questionFontSize` |
  |---|---|---|
  | One short line | ODD ONE OUT | 96 |
  | Two-line analogy | VERBAL ANALOGY | 88 |
  | Mapping row / short math | NUMBER ANALOGY, NUMBER PUZZLE | 80–88 |
  | 3-line sentence | SENTENCE COMPLETION | 58 |

- `options` — array of exactly 4 `{ letter, text }`, letters `A,B,C,D` in order.

**Worked example (VERBAL ANALOGY):**
```ts
{
  kind: "text", idx: 4, tier: "VERBAL ANALOGY", countdown: 5,
  question: "GIANT IS TO TINY AS\nWIDE IS TO ?",
  questionFontSize: 88,
  options: [
    { letter: "A", text: "NARROW" }, { letter: "B", text: "TALL" },
    { letter: "C", text: "LONG" },   { letter: "D", text: "BIG" },
  ],
  ansLetter: "A", ansLabel: "NARROW",
  explanation: "Giant and tiny are opposites, so the opposite of wide is narrow. It's the same relationship, flipped.",
}
```

**Authoring rules by tier:**
- **ODD ONE OUT** — 3 options share one clear category; the 4th breaks it on exactly **one**
  obvious dimension (bird vs fish, operation vs operand). Prompt is always `WHICH ONE DOES NOT BELONG?`.
- **VERBAL ANALOGY** — write `A IS TO B AS\nC IS TO ?`. The relationship (opposite, part-to-whole,
  worker-to-tool, degree/size) must be **the same** on both sides. Distractors are same-topic but
  wrong-relationship words.
- **SENTENCE COMPLETION** — one blank (`______`), context makes exactly one word fit. Keep to ~3
  short lines; use `questionFontSize: 58`. Vocabulary inferable from context at Grade 5.
- **NUMBER ANALOGY** — `WHICH NUMBER FITS?\n2 -> 5,   3 -> 7,   4 -> 9,   5 -> ?`. One consistent
  arithmetic rule (Grade-5 safe: +, −, ×, ÷ only — **no exponents**, see §5.7).
- **NUMBER PUZZLE** — a hidden rule ("`+` secretly means multiply"). The "obvious wrong" reading is
  a required distractor. This is the sneaky finale type.

### 2.2 `numseries` — number series plate

Prompt box + a centered row of number tiles (the last is a `?` tile) + 2×2 text options.

**Fields**
- `prompt` (string) — almost always `WHAT COMES NEXT?`.
- `seq` (string[]) — the tiles, **including** the final `"?"`. Numbers are strings (e.g. `"24"`).
- `options` — 4 `{ letter, text }`.

**Worked example:**
```ts
{
  kind: "numseries", idx: 2, tier: "NUMBER SERIES", countdown: 5,
  prompt: "WHAT COMES NEXT?",
  seq: ["3", "6", "12", "24", "?"],
  options: [
    { letter: "A", text: "36" }, { letter: "B", text: "48" },
    { letter: "C", text: "30" }, { letter: "D", text: "42" },
  ],
  ansLetter: "B", ansLabel: "48",
  explanation: "Each number doubles (x2): 3, 6, 12, 24, so the next is 24 x 2 = 48.",
}
```

**Authoring rules**
- Show **4–6** terms before the `?` so the rule is unambiguous from the tiles alone.
- Grade-5-safe rule families: **constant step** (`+5`, `−8`), **doubling/halving** (`×2`, `÷2`),
  **growing gaps** (`+2,+3,+4,…` or odd-number gaps `+1,+3,+5,…`), **add-the-last-two** (Fibonacci-style).
  **No square/cube number sequences** (Grade 6+ concept — §5.7).
- Distractors: the **off-by-one** result, the **wrong-rule** result (e.g. what `+` would give when
  the rule is `×`), and one plausible near-miss. All same digit-length where possible.

### 2.3 `shaded` — figure analogy plate (nonverbal)

An analogy row of tiles: `[empty L] : [filled L] = [empty R] : [ ? ]`, then 4 **shape** option cards.
Shapes are circle / square / triangle; "filled" shapes use the brand blue ink fill (`SHADE_FILL`).

**Fields**
- `prompt` (string) — `WHICH SHAPE COMPLETES THE PATTERN?`.
- `leftShape`, `rightShape` — each a `GlyphKind`: `"circle" | "square" | "triangle"`.
- `options` — 4 `{ letter, shape, filled }` (`shape` is a `GlyphKind`, `filled` is boolean).
- `ansShape` (`GlyphKind`), `ansFilled` (boolean) — the winning shape + fill state.

**Worked example:**
```ts
{
  kind: "shaded", idx: 3, tier: "FIGURE ANALOGY", countdown: 6,
  prompt: "WHICH SHAPE COMPLETES THE PATTERN?",
  leftShape: "circle", rightShape: "square",
  options: [
    { letter: "A", shape: "square", filled: true },
    { letter: "B", shape: "square", filled: false },
    { letter: "C", shape: "circle", filled: true },
    { letter: "D", shape: "triangle", filled: true },
  ],
  ansLetter: "A", ansShape: "square", ansFilled: true, ansLabel: "FILLED SQUARE",
  explanation: "The relation is 'get filled in' while the shape stays the same, so the empty square becomes a filled square.",
}
```

**Authoring rules**
- The transform is **"empty becomes filled, shape unchanged"**, so the answer is always
  `{ shape: rightShape, filled: true }`. Set `ansShape = rightShape`, `ansFilled = true`.
- Distractors must include: the **right shape but empty** (`{rightShape, false}`), the **left shape
  filled** (`{leftShape, true}`), and a **different shape filled**. Exactly one option is
  `{rightShape, true}`.
- `ansLabel` is `"FILLED <SHAPE>"` (e.g. `FILLED SQUARE`).
- Keep `leftShape ≠ rightShape` so the analogy reads clearly.

### 2.4 `polygon` — figure series plate (nonverbal)

A row of polygons whose **side count** follows a rule, a `?` tile, then 4 polygon option cards.
Supported polygons: **3–8 sides** (triangle…octagon) plus `"circle"`.

**Fields**
- `prompt` (string) — `WHICH SHAPE COMES NEXT?`.
- `seq` (number[]) — side counts, e.g. `[3, 4, 5]` (rendered triangle, square, pentagon).
- `options` — 4 `{ letter, poly }` where `poly` is an integer `3..8` **or** `"circle"`.
- `ansShape` — integer `3..8` or `"circle"`.

**Worked example:**
```ts
{
  kind: "polygon", idx: 11, tier: "FIGURE SERIES", countdown: 7,
  prompt: "WHICH SHAPE COMES NEXT?",
  seq: [3, 4, 5],
  options: [
    { letter: "A", poly: "circle" }, { letter: "B", poly: 6 },
    { letter: "C", poly: 4 },        { letter: "D", poly: 8 },
  ],
  ansLetter: "B", ansShape: 6, ansLabel: "HEXAGON",
  explanation: "The sides count up by one: triangle 3, square 4, pentagon 5, so next is the hexagon with 6 sides.",
}
```

**Authoring rules**
- Rule = **sides ±1** (count up or down). Keep the answer in **3–8**. Prefer answers ≤ 6 sides for
  legibility (heptagon vs octagon are hard to tell apart at a glance).
- `ansLabel` is the shape name (`TRIANGLE`, `SQUARE`, `PENTAGON`, `HEXAGON`, `HEPTAGON`, `OCTAGON`, `CIRCLE`).
- Distractors: a `"circle"` (no side count), the last shape in the sequence (tests "continue vs
  repeat"), and one other polygon. Exactly one continues the rule.

### 2.5 `dot` — position plate (nonverbal)

A dot stepping around a square's corners across tiles, a `?` tile, then 4 position option cards
(each labelled with its corner name).

**Fields**
- `prompt` (string) — `WHERE DOES THE DOT MOVE NEXT?`.
- `seq` (DotPos[]) — positions shown, each `"tl" | "tr" | "br" | "bl" | "center"`.
- `options` — 4 `{ letter, pos }`.
- `ansPos` — a `DotPos`.

**Worked example:**
```ts
{
  kind: "dot", idx: 13, tier: "POSITION", countdown: 7,
  prompt: "WHERE DOES THE DOT MOVE NEXT?",
  seq: ["tl", "tr", "br"],
  options: [
    { letter: "A", pos: "tl" }, { letter: "B", pos: "bl" },
    { letter: "C", pos: "tr" }, { letter: "D", pos: "center" },
  ],
  ansLetter: "B", ansPos: "bl", ansLabel: "BOTTOM-LEFT",
  explanation: "The dot steps clockwise corner to corner: top-left, top-right, bottom-right, then the next corner is bottom-left.",
}
```

**Authoring rules**
- Rule = the dot moves **clockwise** (or counter-clockwise) corner-to-corner. Clockwise order:
  `tl -> tr -> br -> bl -> tl`. Show 3 steps, ask for the 4th.
- `ansLabel` uses the readable corner name: `TOP-LEFT`, `TOP-RIGHT`, `BOTTOM-RIGHT`, `BOTTOM-LEFT`,
  `CENTER`.
- Distractors: a repeat of a shown corner, `center`, and the wrong direction's next corner. Exactly
  one continues the rotation.

---

## 3. The round JSON schema (the contract)

A **round** = one JSON file with metadata + **exactly 15** questions. It mirrors the live
`Question` shape (`remotion/src/data/types.ts`) but is a clean **content** format: it carries the
fields an author/generator controls and omits renderer-derived ones. A machine-readable JSON Schema
stub lives at [`content/schema/round.schema.json`](content/schema/round.schema.json); a full valid
example is [`content/rounds/round-001.json`](content/rounds/round-001.json).

### 3.1 Top-level shape

```jsonc
{
  "round": 1,                       // integer, matches the file number
  "slug": "round-001",              // "round-NNN" (zero-padded to 3)
  "title": "Round 1: ...",          // human title (no em/en dashes)
  "grade": 5,                       // fixed: Grade 5
  "cogatLevel": 11,                 // fixed: CogAT Level 11
  "batteryMix": { "verbal": 6, "quantitative": 6, "nonverbal": 3 },
  "questions": [ /* exactly 15 QuestionItem, id 1..15 in play order */ ]
}
```

### 3.2 `QuestionItem` — common fields

| Field | Type | Notes |
|---|---|---|
| `id` | int 1..15 | Play position; **unique** within the round |
| `kind` | enum | `text` \| `numseries` \| `shaded` \| `polygon` \| `dot` |
| `category` | enum | `verbal` \| `quantitative` \| `nonverbal` |
| `tier` | string | On-screen label (see §1 for the allowed set per kind) |
| `difficulty` | enum | `easy` \| `medium` \| `hard` |
| `countdown` | int | Seconds (5–8); calibrate per [`content/cogat-timing-difficulty.md`](content/cogat-timing-difficulty.md) |
| `ansLetter` | enum | `A` \| `B` \| `C` \| `D` |
| `ansLabel` | string | UPPERCASE answer shown on the reveal card |
| `explanation` | string | 1–2 sentences, sentence case, **no em/en dashes** |

### 3.3 Per-kind fields (discriminated by `kind`)

| `kind` | Extra required fields |
|---|---|
| `text` | `question` (string), `questionFontSize` (int), `options: {letter,text}[4]` |
| `numseries` | `prompt` (string), `seq: string[]` (incl. `"?"`), `options: {letter,text}[4]` |
| `shaded` | `prompt`, `leftShape`, `rightShape` (GlyphKind), `options: {letter,shape,filled}[4]`, `ansShape` (GlyphKind), `ansFilled` (bool) |
| `polygon` | `prompt`, `seq: number[]`, `options: {letter,poly}[4]` (`poly`: int 3..8 \| `"circle"`), `ansShape` (int 3..8 \| `"circle"`) |
| `dot` | `prompt`, `seq: DotPos[]`, `options: {letter,pos}[4]`, `ansPos` (DotPos) |

Enums: `GlyphKind = "circle" | "square" | "triangle"`; `DotPos = "tl" | "tr" | "br" | "bl" | "center"`.

### 3.4 Mapping round JSON → live renderer

The build step (finalized in the ongoing repurposing work — §10) adapts each round JSON item into a
live `Question` object and wires the cut metadata:

| Round JSON | Live target | How |
|---|---|---|
| `id` | `Question.idx` | 1:1 |
| `kind`, `tier`, `countdown`, content, `ans*`, `explanation` | same fields on `Question` | 1:1 |
| `category`, `difficulty` | `cuts.ts` `COG` / `DIFF` maps + `questions.json` | keyed by id |
| (colors) | `bg`/`countFill`/`topicFill`/`clock` | **auto** via `slotColors(idx)` — never authored |
| `qDur`, `rDur` | `Question.qDur/rDur` + `durations.json` | **measured** from TTS audio (§7) |

> **Do not set colors or durations in round JSON.** They are derived. This keeps content portable
> and immune to the render refactor happening in parallel.

### 3.5 Valid example round

See [`content/rounds/round-001.json`](content/rounds/round-001.json) — a complete, schema-valid,
Grade-5-safe round of 15 (6 verbal / 6 quantitative / 3 nonverbal; difficulty 6 easy / 6 medium /
3 hard; answer letters balanced 3·4·4·4; zero em/en dashes). It doubles as **pilot round 1**.

---

## 4. The master question bank (global de-duplication)

> **The single source of truth for "what's been used."** Prompt-level de-dup instructions to the LLM
> are best-effort; **this bank + the validator (§9) are authoritative.** Nothing enters a round that
> collides with the bank, and nothing enters the bank until it passes validation.

### 4.1 What it is

A single, **canonical, monotonically-accumulating** store of **every question ever generated AND
approved** across **all** rounds/videos. It lives at
[`content/master-question-bank.json`](content/master-question-bank.json) (a JSON array of entries; if
it grows unwieldy it can shard to `content/master-bank/round-XXX.json` shards + a rebuilt index —
same schema, see §12). Each entry stores enough to catch **exact and near-duplicates**, not just
identical strings.

```jsonc
{
  "version": 1,
  "updated": "2026-07-18",
  "count": 15,
  "entries": [
    {
      "sig": "text|verbal|odd-one-out|apple~banana~carrot~grape|carrot",  // normalized dedup signature
      "hash": "9f2b1c…",              // short hash of `sig` (fast exact lookup)
      "kind": "text",
      "category": "verbal",
      "tier": "ODD ONE OUT",
      "promptNorm": "which one does not belong",   // normalized prompt text
      "payloadNorm": "apple~banana~carrot~grape",  // normalized type-specific identity (see 4.2)
      "answerNorm": "carrot",
      "ruleTag": "classify:category-outlier",       // optional coarse rule/topic tag (variety metric)
      "round": 1, "slug": "round-001", "id": 1,
      "addedAt": "2026-07-18"
    }
    // … one entry per approved question, forever
  ]
}
```

### 4.2 The dedup **signature** (type-aware)

A generic prompt like `WHAT COMES NEXT?` is identical across **every** number-series item, so the
signature must fold in the **type-specific payload** (the thing that actually makes the item unique),
not just the prompt. Canonicalize by lowercasing, trimming, collapsing whitespace, stripping
punctuation, and **sorting** option sets where order is irrelevant.

| `kind` | `payloadNorm` (identity) | `sig` = |
|---|---|---|
| `text` | sorted normalized `options` + normalized `question` | `text\|{category}\|{tierSlug}\|{payloadNorm}\|{answerNorm}` |
| `numseries` | the `seq` numbers joined (drop `"?"`), e.g. `3~6~12~24` | `numseries\|…\|{seq}\|{answerNorm}` |
| `shaded` | `{leftShape}>{rightShape}=>{ansShape}:{ansFilled}` | `shaded\|…\|{payloadNorm}\|{answerNorm}` |
| `polygon` | `seq` joined + `=>{ansShape}`, e.g. `3~4~5=>6` | `polygon\|…\|{payloadNorm}\|{answerNorm}` |
| `dot` | `seq` joined + `=>{ansPos}`, e.g. `tl~tr~br=>bl` | `dot\|…\|{payloadNorm}\|{answerNorm}` |

- **Exact-duplicate** check = equal `hash` (or equal `sig`). O(1) via a set.
- **Near-duplicate** check = same `kind` **and** (equal `payloadNorm` **or** equal `answerNorm` on a
  reworded prompt **or** fuzzy similarity ≥ threshold on `promptNorm`+`payloadNorm`). For text items,
  identical **option sets** with the same answer = near-dup even if the prompt is reworded. A cheap
  fuzzy metric (token-set Jaccard ≥ 0.85, or Levenshtein ratio ≥ 0.9 on the normalized string) is
  sufficient; upgrade to embeddings only if false-negatives appear.

> **Same rule ≠ duplicate.** Two doubling series with **different numbers** (`3,6,12,24` vs
> `2,4,8,16`) are **distinct** items and both allowed. The signature keys on the *specific* content.
> `ruleTag` is a **soft variety** signal only (§9.6) — used to avoid, say, 40 doubling series across
> 100 rounds — never a hard reject.

### 4.3 Lifecycle (grows only on accept)

1. **Read** the bank before generating a round → hand the generator its signatures/prompts (§8.2).
2. **Gate** every new question against the bank + within the round (§9.4). Regenerate any collision.
3. **Append** only questions that pass the *entire* validation pass, with their `sig`/`hash` +
   provenance (`round`, `slug`, `id`, `addedAt`). Bump `count` + `updated`.
4. The bank is **append-only** (monotonic). Never rewrite history; a question that shipped stays a
   used question forever, so future rounds keep avoiding it.

---

## 5. Authoring guidelines

### 5.1 Difficulty target — Grade 5 / CogAT Level 11

Write for a **10–11-year-old** solver. Rate difficulty by (a) number of reasoning steps, (b) how
familiar the rule is at Grade 5, (c) distractor pull. Single familiar rule = **easy**; one
non-obvious rule = **medium**; multi-step / novel / hidden rule = **hard**. Countdown seconds follow
the ladder in [`content/cogat-timing-difficulty.md`](content/cogat-timing-difficulty.md):

| Type | Base video countdown | Difficulty step |
|---|---|---|
| Verbal analogy / odd-one-out | 5 s | easy −0, hard +1 |
| Sentence completion | 6 s | — |
| Number series / analogy | 6 s | easy −1, hard +1 |
| Number puzzle | 6 s | hard +1 → 7 s |
| Figure (shaded / polygon / dot) | 7 s | easy −1 → 6 s |

**Floor 5 s, cap 8 s.**

### 5.2 Kid-safe language

Kind, non-shaming, age ~10–11. No scary, violent, or unsafe content; no sarcasm aimed at the viewer.
No child-data asks inside a question (the parent-email CTA lives only in the outro — see
[`README.md`](README.md) non-negotiables). Everyday, concrete vocabulary; a "stretch" word is fine
in SENTENCE COMPLETION only if the context makes it inferable.

### 5.3 ZERO em/en dashes

Use **simple punctuation only**. **Banned characters: `—` (em dash, U+2014) and `–` (en dash,
U+2013)** — anywhere in any string (prompts, options, labels, explanations, titles). Use an **ASCII
hyphen `-`** for hyphenated words/ranges (`TOP-LEFT`, `x2`), a period or comma for a pause, and `->`
for mapping arrows. (The math minus glyph `−`, U+2212, is a renderer operator, not punctuation; keep
regular text on ASCII.) The validator hard-fails on any `—`/`–` (§9.5).

### 5.4 Exactly one unambiguous correct answer

Precisely **one** of the 4 options satisfies the stated rule; the other 3 are provably wrong. No "two
could be right" traps, no opinion questions. `ansLetter` must point at that option, and `ansLabel`
must equal that option's text/shape/position. For every distractor, be able to state *why it's wrong*
in one clause.

### 5.5 Strong distractor design

Distractors should be **plausible but clearly wrong on inspection**:
- **Off-by-one / near-miss** (series: the term one step early/late).
- **Wrong-rule result** (what the *obvious wrong* interpretation yields — mandatory in NUMBER PUZZLE).
- **Right-category, wrong-relationship** (verbal analogy: same topic, wrong link).
- **Right-shape-wrong-state** / **wrong-shape-right-state** (figure items).
Keep distractors the **same length/format** as the answer (all 2-digit numbers, all single words) so
length never leaks the answer. **Balance the correct-answer letter** across the round (aim ~4·4·4·3
across A/B/C/D; never let one letter dominate).

### 5.6 Variety, balance & no duplicates

- **Battery mix per round:** verbal 6 · quantitative 6 · nonverbal 3 (the 3 nonverbal = one each of
  `shaded`, `polygon`, `dot`).
- **Difficulty arc:** ramp up; a handful easy, mostly medium, ~2–3 hard, and **end on a hard**
  ("sneaky" NUMBER PUZZLE finale). Reference spread: 6 easy / 6 medium / 3 hard.
- **No two identical tiers back-to-back** (except an intentional two-quant hard closer).
- **Within a round:** no repeated prompt, answer word, or specific pattern; don't reuse a distinctive
  distractor word as another item's answer.
- **Across rounds:** enforced by the **master question bank** (§4) + validator (§9.4) — the hard gate.

### 5.7 Grade-5 concept guardrails

**Reject** any item needing a Grade-6+ concept: **whole-number exponents (squares/cubes)**, negative
numbers, ratios/proportions, decimals beyond money, or algebra. Number patterns use **+ − × ÷** on
whole numbers only. (Per Common Core, squares/cubes are Grade 6 — see the sources in
[`content/cogat-timing-difficulty.md`](content/cogat-timing-difficulty.md) §4/§7. Swap a squares
series for a growing-gap or add-the-last-two series; swap a `n²`/`n³` analogy for `×k` or `×2±1`.)

### 5.8 Explanation format

One to two short sentences, **sentence case** (not UPPERCASE), plain and warm, stating the rule and
applying it to reach the answer. Mirror the reveal-card voice of the live data:
> "Each number doubles (x2): 3, 6, 12, 24, so the next is 24 x 2 = 48."
> "Giant and tiny are opposites, so the opposite of wide is narrow."

No dashes; spell out the arithmetic (`24 x 2 = 48` or "24 times 2 is 48"). This text is shown on the
cream reveal card **and** is the seed for the reveal narration (§7).

---

## 6. Design system summary

Sourced from [`../DESIGN.md`](../DESIGN.md) + `remotion/src/theme/brand.ts` + `fonts.ts` (the live
tokens). This is context for content authors; the parallel render build owns the pixels.

### 6.1 Colors (exact sRGB hexes)

| Role | Name | Hex |
|---|---|---|
| Ink | Black | `#000000` |
| Paper | White | `#FFFFFF` |
| Accent 1 | Periwinkle blue | `#839AFF` |
| Accent 2 | Mint | `#C6FCD0` |
| Accent 3 | Coral | `#FD7962` |
| Accent 4 | Yellow | `#FCE552` |
| Neutral | Cream | `#F6F4EE` |
| Logo/CTA | Green | `#63C088` |

### 6.2 Fonts

- **Anton** — display / headlines / prompts / numbers. UPPERCASE, tight line-height (~0.95–1.05).
- **DM Sans** — body / option text / explanations / labels (weights 400/500/700/800).
- Two typefaces only.

### 6.3 Neo-brutalist rules (the four signatures)

1. **Thick pure-black outlines** on every object (cards, pills, tiles, badges) — ~4–9px at 1080p.
2. **Hard offset drop-shadows, ZERO blur** — a solid black copy offset down-right (the #1 signature).
3. **Anton UPPERCASE** display + **DM Sans** body.
4. **Flat bright color-blocking** — no gradients, glows, or soft shadows.
Rounded corners (~22–40px on cards/tiles; full-pill for badges/buttons).

### 6.4 "No black backgrounds / no black buttons" + rotating colors

- **Ink is used ONLY for text, borders, and shadows** — **never** as a plate background or a
  button/pill fill. Every plate background and every pill/card fill is a **bright brand color** (or
  paper/cream) so its black border + hard shadow read. (Green is reserved for the logo, the outro
  field, and CTAs.)
- **Rotating distinct colors per plate.** The renderer derives four plate "slots" — background,
  "QUESTION X OF 15" pill, topic/tier pill, countdown clock — from a rotating 5-color palette
  (`SLOT_PALETTE = [blue, mint, coral, green, yellow]`) keyed to the question's `id`. It takes **four
  consecutive** entries, so all four are **mutually distinct** and **shift every question**, and
  consecutive plates never look the same. **Authors do not pick colors** (see §3.4). Letter badges are
  fixed: **A=blue, B=mint, C=coral, D=yellow**; filled figures use blue ink.

### 6.5 Plate types (5)

| Plate | Field color | Role |
|---|---|---|
| **Intro** | yellow | "SMART FELLA / OR / FART SMELLA?" hero + brain logo |
| **Question** | rotating (per §6.4) | Header pills + prompt + options + countdown chip + depleting bar. Has a **read** state (timer full) then a **countdown** state (timer depletes, "TIME'S UP" VO) |
| **Reveal** | mint | "CORRECT ANSWER" banner + answer card (letter badge + answer) + explanation card |
| **Score** | blue | "ARE YOU SMART OR FART?" + 3 scoring tiers (Certified Smart Fella / Sharp Cookie / Certified Fart Smella) |
| **Outro** | green | "HOW DID YOU DO?" + platform CTA (Subscribe / Follow) |

### 6.6 Output formats

- **16:9 landscape — 1920×1080** (YouTube long-form; the `FullVideo` composition).
- **9:16 portrait — 1080×1920** (Instagram/TikTok shorts; the `Short` composition).
- Both at **30 fps**; the **same** component tree re-flows per aspect (never letterboxed). Encode
  intent: H.264, `yuv420p`, CRF 16 (see `remotion/remotion.config.ts`). Every round renders to
  **both** formats.

---

## 7. Narration / VO contract

Each video's audio is a set of per-**beat** narration clips (ElevenLabs, the cloned game-show host
"Smart Fella Host"). Content generation must also emit the **VO script per beat**; TTS then produces
the mp3s, and their measured durations feed the render timeline (`durations.json`).

**Beats per round:** `intro`, `q1..q15`, `timesup`, `r1..r15`, `score`, `outro` (YouTube/Follow
variants). **Meta beats are reusable across all rounds** (`intro`, `timesup`, `score`, `outro-*`
never change) — **only `q1..q15` + `r1..r15` are generated per round**.

**Script style (from `voice/narration/narration_index.json`):**
- Host energy, `[excited]` performance tag at the start of question/reveal beats.
- **Numbers spelled out** for TTS ("twenty-four", "forty-eight"); shapes/positions described in words.
- Options always read `A, … B, … C, … or D, …?` then the countdown (`Five seconds, go!`).

**Per-beat templates:**
```text
q{N}:  [excited] Question {N}{, a {type phrase}}! {prompt spoken, terms/members listed}.
       A, {optA}... B, {optB}... C, {optC}... or D, {optD}? {countdown} seconds{, go}!
r{N}:  [excited] {The answer is / It's}... {letter}, {answer}! {explanation, host-styled, spelled-out math}.
```

Where `{type phrase}` is e.g. "a number series", "a word analogy", "a picture puzzle", "fill in the
blank". Keep reveal wording aligned with the JSON `explanation`.

> **Timing:** `countdown` (authored) sets the on-screen clock; `qDur`/`rDur` come from measuring the
> generated mp3s, so per-question video length is a function of the VO, not hand-set.

---

## 8. AI generation approach

### 8.1 Goal

Given (a) these templates + schema, (b) the guidelines, and (c) a **compact view of the master bank**,
the LLM emits **one round of 15 as JSON** that validates on the first or second pass. Prompt-level
de-dup is **best-effort**; the validator (§9) is the authority.

### 8.2 What the generator is given

1. **Round spec:** `round` number, target battery mix (6/6/3), difficulty arc (6/6/3, end hard),
   the per-kind field templates (§2), and the JSON schema (§3).
2. **Master-bank awareness** (§4) — one of, depending on bank size:
   - **Full list** of existing `sig`/`promptNorm` values (fine up to a few thousand).
   - **Compact/per-type representation** if the bank is large: for each tier, a **sample** of recent
     items + **all** `payloadNorm`s of that type (sequences/members/mappings are short), plus
     per-type **coverage counts** so the model steers toward under-used rules/topics.
   - Instruction verbatim: *"Do NOT repeat or trivially reword any of these. Every item must be a
     genuinely new question. Prefer rules, topics, and numbers not yet represented."*
3. **Per-type coverage** so it explores new ground (e.g. "series rules used so far: doubling ×N,
   +5, odd-gaps; try halving, add-last-two, or a fresh constant step").

### 8.3 Prompt design (paste-ready skeleton)

```text
SYSTEM
You are a Grade-5 (CogAT Level 11) quiz item writer for a kids' quiz show. You output ONLY valid
JSON matching the provided round schema. Every question is original, kid-safe, and has exactly one
unambiguous correct answer. You NEVER use em dashes or en dashes (— or –); use simple punctuation.
You never use Grade-6+ math (no squares, cubes, exponents, negatives, ratios, algebra).

USER
Generate round {N} as one JSON object per this schema:
{paste content/schema/round.schema.json}

Templates (fields + rules) for each kind:
{paste §2 templates}

Requirements:
- Exactly 15 questions, ids 1..15 in play order.
- Battery mix: verbal 6, quantitative 6, nonverbal 3 (nonverbal = one shaded, one polygon, one dot).
- Difficulty: ~6 easy, ~6 medium, 3 hard; ramp up; the LAST item is a hard NUMBER PUZZLE.
- countdown per the timing table (verbal 5, sentence 6, number 6[+1 hard], figure 7[-1 easy]); cap 8.
- Exactly one correct option; 3 strong wrong distractors (same length/format); balance the correct
  letter across A/B/C/D (~4·4·4·3).
- explanation: 1–2 sentences, sentence case, spelled-out arithmetic, no dashes.

GLOBAL DE-DUP — do NOT repeat or trivially reword any of these already-used items:
{paste master-bank signatures / per-type prompts + payloads + coverage counts}

Return ONLY the JSON.
```

### 8.4 Regeneration loop

Feed the output to the validator (§9). For every rejected item, ask the model to **replace just that
id** (pass the reason + the item to avoid) — do not regenerate the whole round. Repeat until the
round is 100% valid and 100% unique vs the master bank.

---

## 9. Automated validation pass

A round is **not** accepted until it passes **all** checks below. The validator is a small script
(finalized alongside the batch build — §10; not created by this doc). Order matters: cheap structural
checks first, dedup last.

### 9.1 Schema validity

Parses as JSON; matches [`content/schema/round.schema.json`](content/schema/round.schema.json):
15 questions; ids `1..15` unique; every `kind` has its required fields; `options` length 4 with
letters `A,B,C,D`; enums valid (`category`, `difficulty`, `GlyphKind`, `DotPos`, poly `3..8|circle`);
`countdown` in 5..8.

### 9.2 Exactly-one-correct-answer

- `ansLetter ∈ {A,B,C,D}` and appears once in `options`.
- `ansLabel` matches the correct option's `text` (text/numseries) / derived shape label
  (`FILLED SQUARE`, `HEXAGON`, `BOTTOM-LEFT`).
- For `shaded`: exactly one option equals `{ansShape, ansFilled}`. For `polygon`: exactly one option
  `poly === ansShape`. For `dot`: exactly one option `pos === ansPos`.
- **Semantic one-correct** (rule actually yields the answer, and no distractor also does) is checked
  by a lightweight LLM-judge or, for `numseries`/mapping, a numeric rule check where feasible; flag
  low-confidence items for human review in the pilot.

### 9.3 No em/en dashes & Grade-5 math

- Hard fail if any string matches `/[\u2013\u2014]/` (en/em dash).
- Flag Grade-6+ concepts: reject series/analogies that are perfect squares/cubes; flag negatives,
  decimals (beyond money), exponent notation.

### 9.4 De-duplication (intra-round + master bank) — the hard gate

For each question compute its `sig`/`hash` (§4.2), then:
1. **Intra-round:** no two questions in this round share a `hash`, `payloadNorm`, or near-dup match.
2. **Master bank:** the `hash` is **not** in the bank; and no near-dup (same `kind` + equal
   `payloadNorm`/`answerNorm`, or fuzzy `promptNorm+payloadNorm` ≥ threshold) exists in the bank.
Any hit → **reject that item**, request a replacement (§8.4), re-check. Loop until the whole round is
unique **within itself and against the entire bank**.

### 9.5 Difficulty & timing sanity

- Battery mix = 6/6/3; nonverbal = one each of `shaded`/`polygon`/`dot`.
- Difficulty distribution within tolerance (e.g. easy 5–7, medium 5–7, hard 2–4) and **item 15 is
  hard**.
- `countdown` matches the §5.1 ladder within ±1 s of the recommended value for its type/difficulty.

### 9.6 Balance (soft warnings, not hard fails)

- Correct-answer letters roughly even (no letter > 5 of 15).
- `ruleTag` spread: warn if the round (or the bank overall) is over-concentrated in one rule/topic
  (e.g. too many doubling series). Soft — nudges variety, never blocks a valid unique item.

### 9.7 Append on accept

Only after a round passes **9.1–9.5** do its 15 questions get **appended** to
`content/master-question-bank.json` (with `sig`, `hash`, provenance, `addedAt`); bump `count` +
`updated`. The round JSON is then written to `content/rounds/round-NNN.json`. If any later step fails,
**nothing** is appended (the bank never contains an unshipped/invalid item).

---

## 10. Pipeline flow (high level)

```
                ┌─────────────────── master-question-bank.json (accumulating) ───────────────────┐
                │  read signatures ↓                                          ↑ append on accept  │
  AI generate ──►  round-NNN.json (15 Qs)  ──►  VALIDATE (§9)  ──►  [reject → regenerate item]    │
                                                     │ pass                                        │
                                                     ▼                                             │
                     narration scripts (q1..q15, r1..r15)  ──►  TTS (cloned host)  ──►  mp3s ──────┘
                                                     │
                                                     ▼  measure durations → durations.json
                                     RENDER  ──►  16:9 (1920×1080)  +  9:16 (1080×1920)
                                                     │
                                                     ▼
                              per-video folder: mp4 + captions.srt/.vtt + questions.json + info.md
```

1. **Generate** a round JSON (§8), bank-aware.
2. **Validate** (§9) — regenerate individual items until fully valid + globally unique.
3. **Append** the 15 accepted questions to the master bank; write `content/rounds/round-NNN.json`.
4. **Narrate** — emit q/r VO scripts, synth via the cloned voice, measure durations.
5. **Render** both aspects; **file** each video in its per-video folder + update the manifest.

> **In flux — do not hardcode paths.** The exact render/folder wiring (how a round JSON is fed to the
> renderer, per-video directory layout, batch script) is being finalized in the current repurposing
> build. Today the renderer reads a single committed round from `remotion/src/data/questions.ts` and
> `scripts/build-cuts.ts` emits per-cut `renders/videos/<platform>/<slug>/{mp4,questions.json,info.md,
> captions.*}` + a top-level `manifest.json`. The batch pipeline will generalize this to N rounds;
> treat those specifics as **current convention**, not a frozen contract.

---

## 11. Mass-generation plan

**Phase 0 — Pilot (3–5 rounds).** Generate rounds `round-001..round-005` (round-001 is the committed
example). Run the full validator; render 1–2 to both formats. **User reviews and sets the quality
bar** (item quality, difficulty feel, distractor strength, host VO, on-brand render). Iterate the
generation prompt + validator thresholds until the pilot clears the bar.

**Phase 1 — Scale (~100 rounds).** With the bar locked, batch-generate to **~100 rounds × 15 = ~1,500
unique questions**, each round bank-checked so **no question repeats across the entire library**.
Generate → validate → append-to-bank → narrate → render, in batches, monitoring:
- Master-bank growth + zero-duplicate invariant (§4, §9.4).
- Battery/difficulty mix per round (§5.6) and rule-variety across the bank (§9.6).
- Render success to **both** 16:9 and 9:16 per round.

**Throughput note:** meta VO beats are reused, so per round only 30 VO clips (q1..q15 + r1..r15) are
synthesized; everything else is deterministic.

---

## 12. Folder & naming conventions

```
video/
├── CONTENT_PIPELINE.md              # this doc
└── content/
    ├── schema/
    │   └── round.schema.json        # JSON Schema for a round (the contract, §3)
    ├── rounds/
    │   ├── round-001.json           # one file per round; zero-padded 3 digits
    │   ├── round-002.json
    │   └── … round-100.json
    ├── master-question-bank.json    # accumulating global dedup store (§4) — single source of truth
    └── (existing content docs: starter-quiz-bank.md, cogat-*.md — unchanged)
```

- **Rounds:** `content/rounds/round-NNN.json`, `NNN` zero-padded (`round-001`, …, `round-100`).
  `slug` inside the file equals the filename stem; `round` equals the integer.
- **Master bank:** `content/master-question-bank.json`. If it outgrows a single file, shard to
  `content/master-bank/round-NNN.json` (per-round shards) + a regenerated
  `content/master-bank/index.json` (all `sig`/`hash`) — same entry schema.
- **Per-video outputs** follow the current render convention (in flux, §10):
  `renders/videos/<platform>/<slug>/` with `{mp4, questions.json, info.md, captions.srt, captions.vtt}`
  + top-level `renders/videos/manifest.json`.

---

## 13. Open questions for the user

1. **Scope of kinds.** Mass-gen currently targets the **5 code-drawn plate kinds** only (no bespoke
   art). Do you want to expand the renderer to cover the richer puzzle types in
   `starter-quiz-bank.md` (riddles, trivia, spot-the-difference, optical), or keep the automated line
   CogAT-only? (Adding those needs new renderers/art + new schema kinds.)
2. **Master-bank storage.** Single `content/master-question-bank.json` vs sharded
   `content/master-bank/` — preference? (Single is simplest for ~1,500 items; shard only if it hurts.)
3. **Near-dup strictness.** Is same-rule / different-numbers acceptable (recommended: yes, it's a new
   item), with only a **soft** cap on rule over-use? Or do you want a harder cap (e.g. max N doubling
   series across the whole library)?
4. **Semantic one-correct verification.** For the auto-validator, is an **LLM-judge** acceptable for
   the "no distractor is also correct" check, or do you want deterministic solvers only (feasible for
   numeric kinds, harder for verbal)?
5. **Difficulty mix.** Lock the target as **6 easy / 6 medium / 3 hard** (used in round-001), or a
   different arc (e.g. the curated 4/9/2)?
6. **Round count & cadence.** Confirm **~100 rounds** as the Phase-1 target and how many to render up
   front vs generate-then-render on demand.
7. **VO cost at scale.** ~100 rounds × 30 clips = ~3,000 TTS calls. OK to batch on the current
   ElevenLabs plan, or should we gate rendering to validated-and-approved rounds only?
