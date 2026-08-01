# ab-testing/ — the campaign A/B "brain"

> **Publer is retired (2026-07-28).** Every mention of Publer below is historical.
> Posting, the live calendar and analytics all run on Metricool now — see
> [`docs/hermes/metricool-migration.md`](../docs/hermes/metricool-migration.md).

This folder is the accumulating memory for the **Smart Fella or Fart Smella** short-form
video experiment. It correlates every **published post** back to the **rendered video
variant** it came from, tags it with **A/B dimensions**, and joins it to **performance
metrics**. A future automated posting loop reads this to decide what to render/post next,
and writes new records + fresh metrics back into it.

> **Status: v1, tiny sample (14 posts).** Nothing here is statistically meaningful yet.
> See `analysis-2026-07-21.md` for the first-look read and its (large) caveats.

## Files

| File | What it is |
|---|---|
| `ab-database.json` | The database. One record per post (posted/scheduled/draft) + per-family rollups. Source of truth (raw facts). |
| `learnings.json` | The **decisions brain**: aggregated rollups (family/platform/hashtag_set/time-bucket), current front-runners, and an append-only decisions log. Derived from `ab-database.json`. |
| `hook-bank.json` | Pre-approved, in-voice, **claim-safe** opening lines and captions, grouped by psychological MECHANISM so arms test mechanisms rather than individual sentences. See "The hook bank" below. |
| `README.md` | This file — schema + how to grow the DB. |
| `analysis-2026-07-21.md` | First-look analysis with hypotheses and caveats (a dated snapshot; add new dated files over time). |

## Where the data came from

- **Posts:** Publer sync → `.ab-tmp/publer-posts-raw.json` (14 posts across 2 accounts). The
  Publer **API key is never stored** in this folder or the DB.
- **Metrics:** a Publer post-analytics screenshot (page 1 of 2, captured ~2026-07-21 15:11).
  10 of the 14 posts have metrics; the other 4 are `pending`.
- **Variants:** the render metadata already in this repo —
  `renders.nosync/videos/ab-tests/manifest.json`, `renders.nosync/videos/manifest.json`,
  `renders.nosync/videos/ready-to-post/*/caption.txt`, and `content/ab-test-usage.json`.

## The schema (v1)

Top level:

```jsonc
{
  "schema_version": 1,
  "updated_at": "<ISO8601>",
  "campaign": "Smart Fella or Fart Smella",
  "accounts": { "<account_id>": { "platform", "handle" } },
  "inputs": { ...provenance, NO secrets... },
  "conventions": { ...units + how to read match_confidence/reach_rate... },
  "posts": [ /* one record per published post */ ],
  "variant_families": { "<family>": { count, metrics_n, avg_eng_rate, avg_reach, drafts, scheduled, notes } },
  "aggregate_cuts": { "by_platform": {...} },
  "known_gaps": [ ... ]
}
```

Each `posts[]` record:

```jsonc
{
  "publer_post_id": 195306517,          // Publer's own numeric post id
  "platform_post_id": "7664675...",     // native TikTok/IG id
  "platform": "tiktok" | "instagram",
  "account_id": "6a5fc5451bee22495517bcc5",
  "account_handle": "@smartfellafartsmellatest",
  "permalink": "https://...",
  "posted_at": "2026-07-20T13:14:55-05:00",
  "caption": "…verbatim caption…",

  "source_video": "renders.nosync/videos/ready-to-post/01-.../video.mp4" | null,
  "source_candidates": [ "…", "…" ],    // populated when source_video is null/ambiguous

  "variant": {
    "family": "standard|no-answer|cliffhanger|dont-narrate|speed|one-question|mascot|intro-promo",
    "narration": "full|none|no-question-vo|no-options-vo",
    "hook": "score-CTA|comment-CTA|brand",
    "question_types": ["odd-one-out", "figure-analogy", "number-series"],
    "num_questions": 3
  },
  "hashtag_set": "A|B|C",               // which rotating hashtag set is appended (hashtag A/B dimension; sets in learnings.json)
  "post_state": "scheduled|draft",      // for loop-created posts; ABSENT on historically-posted rows
  "scheduled_at": "2026-07-21T18:30:00-05:00",  // present when post_state=scheduled (ISO, -05:00)

  "metrics": {
    "reach": 991, "reach_rate": "12.4%", "video_views": null,
    "reactions": 55, "comments": 0, "shares": 0,
    "eng_rate": 5.55,                   // PERCENT (5.55 == 5.55%)
    "link_clicks": null, "ctr": null,
    "as_of": "2026-07-21",
    "source": "screenshot" | "pending"
  },

  "match_confidence": "high|medium|low",
  "notes": ""
}
```

### Field conventions (see `conventions` in the JSON too)

- **`eng_rate`** is a percent number. **`reach_rate`** is stored as the raw string Publer
  showed (e.g. `"3.1K%"`) because TikTok's values are unreliable at a near-zero follower
  count — do not do math on them yet.
- **`metrics.source`**: `"screenshot"` = read from the 2026-07-21 analytics view;
  `"pending"` = not captured yet (fill on the next analytics pull).
- **`match_confidence`**:
  - `high` — exact render pinned (caption body matches a `ready-to-post/*/caption.txt`
    verbatim, i.e. a unique question-type fingerprint; or it's the single brand-intro asset).
  - `medium` — the **family** is certain from the caption, but the exact render is 1 of 2
    indistinguishable siblings (`video-1` vs `video-2`). `source_video` is `null`; see
    `source_candidates`.
  - `low` — even the family is uncertain; a human should confirm.
- **The `intro` dimension was dropped (2026-07-21)** — every short is cold-open now, so
  records no longer carry `intro` (and the old `by_intro_standard_only` cut was removed). The
  reason (WITHINTRO underperformed) is preserved in `learnings.json` → `decisions_log`.
- **`hashtag_set`** (`A`/`B`/`C`) records which rotating hashtag set was appended to the
  caption — a live A/B dimension. The three sets are defined in `learnings.json`.
- For `no-answer`/`cliffhanger`, `question_types` come from the render family's tiers (they're
  identical across `video-1`/`video-2`), not from the caption.

## How to add a record (the loop's write path)

1. **Render** a variant. It already lands under `renders.nosync/videos/...` with a
   `caption.txt` / `info.md` / `questions.json` sidecar. Keep that sidecar — it's the join key.
2. **Post** it (Publer). Capture `publer_post_id`, `platform_post_id`, `permalink`,
   `posted_at`, `platform`, `account_id`, and the exact `caption`.
3. **Append** a `posts[]` record. Because the loop knows exactly which render it posted, set
   `source_video` to that render's repo-relative path and `match_confidence:"high"`
   (no caption-guessing needed — that's only for back-filled history like this v1 batch).
4. Copy the render's `variant` block straight from the render metadata (family, narration,
   hook, question_types, num_questions). Set `hashtag_set` to the set you appended.
5. Set `metrics.source:"pending"` at post time (metrics don't exist yet).
6. Bump top-level `updated_at`, then recompute `learnings.json` (see below).

**Idempotency:** treat `platform_post_id` as the unique key. If a record with that id exists,
update it in place instead of appending a duplicate.

## How to refresh metrics (the loop's update path)

1. Pull analytics (Publer API / MCP). For each post, match on `platform_post_id`.
2. Overwrite the `metrics` block: `reach`, `reach_rate`, `video_views`, `reactions`,
   `comments`, `shares`, `eng_rate`, `link_clicks`, `ctr`; set `as_of` to the pull time and
   `source:"screenshot"` → change to `"api"` once you're pulling programmatically (add `"api"`
   as an allowed value when you do).
3. Recompute `variant_families` and `aggregate_cuts` rollups.
4. Bump `updated_at`.
5. Recompute `learnings.json` (see below).

## `learnings.json` — the decisions brain

`ab-database.json` is raw per-post facts; **`learnings.json` is the aggregated, decision-oriented
view the loop actually acts on.** Keep them in sync:

- **Read (before posting):** consult `front_runners` + `rollups` to bias the next batch toward
  the best-performing `variant_family`, `hashtag_set`, `platform`, and `time_bucket`; read
  `decisions_log` so you don't re-test settled questions (e.g. `intro` is dropped — don't
  reintroduce it).
- **Write (after a metrics pull):** recompute every rollup from `ab-database.json` `posts[]`
  whose `metrics.source != "pending"`, update `front_runners` (highest median `eng_rate` with
  `n_with_metrics >= conventions.min_n`), append any new conclusion to `decisions_log` (never
  delete — supersede), and bump `updated_at`.
- **Dimensions tracked:** `variant_family`, `platform`, `hashtag_set` (A/B/C), `time_bucket`
  (morning/midday/evening, America/Chicago).

## The hook bank (`hook-bank.json`)

The single thing worth attacking is the **77.2% median skip rate** — three quarters of
viewers gone in three seconds. Only two surfaces can move it, and they are different jobs:

- **`openings[]`** — the spoken opener plus the plate it burns in, BEFORE question one.
  This is the one that fights the skip rate.
- **`captions[]`** — near-zero retention effect, but free to improve, and `publishGate.ts`
  enforces exact-match caption novelty over `NOVELTY_WINDOW = 30`, so fresh bodies are a
  standing requirement regardless.

Lines are grouped under `mechanisms` (eight of them) rather than listed flat. At our sample
sizes an individual sentence is noise; a mechanism with four to seven interchangeable
phrasings can reach the `min_sample: 5` bar in `content-defaults.json` and produce a result
that means something.

`stated-difficulty-stat` is the priority category and carries the largest allocation
(7 openings, 6 captions). `declared-difficulty` is deliberately the same hook with the
number removed, which makes the two of them the cleanest single-variable A/B in the bank.

### Claim rules (read this before adding a line)

**A number attached to how hard the QUESTION is, is in policy. A number attached to what
the PRODUCT does for the viewer, is not.** That is the whole rule.

`97% get this wrong`, `only 3% spot it`, and `9 out of 10 pick B` are difficulty framing.
They are genre convention for this format, nobody reads them as statistics, and they are
approved (owner decision, 2026-07-31, recorded in `claim_rules.owner_approval`). We do not
have data behind them and do not pretend to.

`97% of players raise their score`, `users get smarter in a week`, and anything else
shaped like an efficacy promise about the app stay out. That is a different category, it is
the kind that actually gets challenged, and it is not what the format needs. Where a source
hook made an outcome claim, the number was moved onto the question's difficulty instead.

Every line carries a `claim_class`:

| `claim_class` | Means | Example |
|---|---|---|
| `stated-stat` | An unmeasured number about **the question's** difficulty | `Ninety seven percent get this wrong.` |
| `none` | Asserts nothing: an imperative, a question, a dare, or a rule we define | `Bet you can't get all three.` |
| `opinion` | A subjective judgement of **our own puzzle** | `Heads up. This one is sneaky.` |
| `self-verifiable` | A fact readable straight off the render props | `Two answers. One secret.` |
| `measured` | A real statistic with a stated population and n | none yet, and nothing waits on it |

Two things are still excluded, for different reasons. **Product-efficacy and creator-result
claims** are excluded on the rule above. **Uncontrolled per-item pre-judgements** (`the
obvious answer is wrong`) are excluded for internal consistency, not policy: the bank
attaches to a randomly selected question, so a hook that guesses the answer will contradict
its own reveal on camera. The one version worth keeping, naming a decoy option, survives as
`open-stat-07` with a `fill` block the selector must resolve to a letter that is *not* the
answer.

`numeric_claims.upgrade_path` records the two ways we could put a real number behind the
pattern later (grading comments against the answer key at volume, or norming an item before
it ships). Neither is required. A real number is just strictly better than an invented one
at the same cost.

### `requires` is load-bearing

A line's `requires` block pins the render props it depends on to stay true. Picking a
`{"ending": "cliffhanger"}` line for a `full-reveal` arm converts a `self-verifiable`
line into a false one, so a selector must honour it. `null` means unconditional.

### The opening surface: the hook rides the animation

The campaign read on 41 matured posts put the wordless **motion opening 5.6 percentage
points WORSE than the cold plate** on skip rate. The likely cause is arithmetic rather
than aesthetic: it spends 2.2 seconds on animation that carries no information, and the
median viewer leaves at three. So the hook does not add time, it makes the existing time
work. The line is spoken **over** the animation and the title replaces its wordless `?`.

Everything sits on ONE axis, the `opening` dimension:

| arm | question one arrives | what it is |
|---|---|---|
| `cold-plate` | **0.00s** | control, the historical cold open |
| `motion-hook` | **2.20s** | today's wordless arm |
| `motion-hook-<mechanism>` | **2.20s** | the same 2.2s, now carrying a payload |

`motion-hook` against `motion-hook-<mechanism>` isolates the payload with the animation
held constant; either against `cold-plate` isolates the whole opening.

**The cold plate never gets a hook.** On an arm with no animation to hide under, a hook
would have to be serial, which is the delay this design removes. `render.ts mapProps`
drops hook copy unless `opening` is `motion-hook`, so that combination is unrepresentable
rather than merely discouraged, and no arm can be quietly confounded.

### The spoken budget

A line must fit inside the animation: **2.08s hard** (2.2s minus the 0.12s lead), and only
**1.93s or less is offered**, because ElevenLabs is generative and one line measured 2.08s
at calibration then came back 2.16s on a real render. Three things enforce it:

1. `tools/calibrate-hooks.ts` synthesizes every line once and records its real length as
   `vo_sec`. Word count is not a usable proxy: the host puts about half a second of air at
   each sentence boundary, so a four-word two-sentence line measured *longer* than a
   six-word one-sentence line. Re-run it after editing any `vo`.
2. `hooks.ts` refuses anything unmeasured or over the offer threshold. Unmeasured fails
   closed; we never guess.
3. `render.ts` re-checks the measured clip at synth time and drops it if it overran, so the
   video degrades to the wordless motion arm rather than growing the delay.

**22 of 31 opening lines are currently offered**, every mechanism has at least one, and
captions are unaffected (they have no time budget).

## Posting defaults (poster tooling)

`tools/post-variant.ts` / `tools/post-to-publer.ts` now default to: the caption
"**Are you SMART or FART? … Comment your score/answer below … and follow for more!!**"
(no baked-in hashtags — the loop appends a rotating `hashtag_set` via `tools/edit-captions.ts`),
and **Instagram share-to-Feed ON** (`networks.instagram.details.feed=true`, only settable at
creation).

## Growing the schema

- Bump `schema_version` when you change record shape; write a one-line migration note in the
  PR. Old records without a new field should still read (treat missing as `null`).
- Safe **additive** extensions to expect next: `saves`, `watch_time`, `avg_watch_pct`,
  `follows_from_post`, `retention_curve`, `first_frame`/`hook_text`, `music_track`,
  `posting_hour`, `day_of_week`, a `thumbnail` variant, and an experiment/cohort id so posts
  rendered for the same test can be grouped.
- Keep it **append-only + versioned**. Never delete history; supersede with a new record or a
  corrected field + a `notes` entry.

## Guardrails

- **No secrets** in this folder, ever (no Publer API key, no tokens).
- The loop should only ever **read** render media and **write** here (and to its own posting
  logs). Don't mutate `renders.nosync/` sidecars from the posting loop.
