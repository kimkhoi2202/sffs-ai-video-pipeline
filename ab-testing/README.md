# ab-testing/ — the campaign A/B "brain"

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
| `ab-database.json` | The database. One record per published post + per-family rollups. Source of truth. |
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
  "variant_families": { "<family>": { count, metrics_n, avg_eng_rate, avg_reach, notes } },
  "aggregate_cuts": { "by_platform": {...}, "by_intro_standard_only": {...} },
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
    "intro": true | false,              // branded lead-in before Q1
    "narration": "full|none|no-question-vo|no-options-vo",
    "hook": "score-CTA|comment-CTA|brand",
    "question_types": ["odd-one-out", "figure-analogy", "number-series"],
    "num_questions": 3
  },

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
- **A/B-test shorts are permanently cold-open** (`intro:false`); only the `ready-to-post`
  `WITHINTRO` packages and the brand promo have `intro:true`.
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
4. Copy the render's `variant` block straight from the render metadata (family, intro,
   narration, hook, question_types, num_questions).
5. Set `metrics.source:"pending"` at post time (metrics don't exist yet).
6. Bump top-level `updated_at`.

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
