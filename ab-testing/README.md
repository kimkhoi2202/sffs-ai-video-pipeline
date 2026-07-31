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

Lines are grouped under `mechanisms` (eight of them, plus one reserved-and-empty) rather
than listed flat. At our sample sizes an individual sentence is noise; a mechanism with
four or five interchangeable phrasings can reach the `min_sample: 5` bar in
`content-defaults.json` and produce a result that means something.

### Claim rules (read this before adding a line)

`compliance.md` §3 requires that every claim be "truthful and substantiated; nothing
misleading about difficulty, odds". We have **no measured item-difficulty data** — the
question bank's `tier` is a question TYPE, not a difficulty, and there are 10 comments in
the entire database — so every line carries a `claim_class`, and only four are legal:

| `claim_class` | Means | Example |
|---|---|---|
| `none` | Asserts nothing: an imperative, a question, a dare, or a rule we define | `Bet you cannot get all three.` |
| `opinion` | A subjective judgement of **our own puzzle** | `Heads up. This one is sneaky.` |
| `self-verifiable` | A fact readable straight off the render props | `Two answers. One secret.` |
| `measured` | A real statistic with a stated population and n | **reserved, currently empty** |

Anything asserting how many *people* get something right or wrong is banned, and that
includes the soft form. `most people miss this` is cut for the same reason as `97% fail`:
both quantify a population we have never measured, and the "nothing misleading about
difficulty" rule has no soft-claim exemption. The bank's `provenance.what_was_screened_out`
records what that removed.

`honest_numbers` in the bank spells out the two ways we could earn a real number (grading
comments against the answer key at volume, or deliberately norming an item before it ships).
Neither is assumed. Until one is executed, `measured-difficulty` stays empty.

### `requires` is load-bearing

A line's `requires` block pins the render props it depends on to stay true. Picking a
`{"ending": "cliffhanger"}` line for a `full-reveal` arm converts a `self-verifiable`
line into a false one, so a selector must honour it. `null` means unconditional.

### Before this can ship

The opening surface **is not wired yet**. `design.ts` writes `plan.props.title` /
`plan.props.subtitle` from a dimension's `hook`, but `render.ts shortProps()` never forwards
them, and `remotion/src/full/timeline.ts` makes shorts permanently cold-open. Today the
`hook-challenge` arm renders a video byte-identical to control. Wiring it means forwarding
the two props, adding an intro segment to the short timeline, and adding an `intro` beat to
`narration.ts planBeats`. Retire the existing `ONLY 1% PASS` hook copy at the same time — it
is exactly the unsubstantiated difficulty claim §3 forbids, and it has never shipped, so
removing it costs nothing.

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
