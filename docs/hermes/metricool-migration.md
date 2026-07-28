# Metricool migration — EXECUTED (2026-07-28)

**Status: DONE.** Publer is fully removed from the SFFS Hermes system. This document is
kept as the record of what changed and, more importantly, as the reference for the
identifier model and the silent-failure traps, which are still live concerns every time
anyone touches `hermes/src/metricool.ts`.

## Why we left Publer

Publer's API answers **HTTP 403 on every content endpoint** with
`{"errors":["Please upgrade to Business to access our API."]}`. No upgrade is being
purchased. Before the cutover this meant:

- the do-not-touch snapshot always threw, so the cycle took its fail-closed branch and
  created nothing — an armed loop rendered a full batch and scheduled none of it;
- `score.ts` scored nothing, so every rollup it recomputed was built on stale data;
- the dashboard's schedule panel was structurally unable to show the truth: it rendered
  empty while 41 posts sat on the calendar.

A separate reason not to go back: a Publer **bulk delete once wiped every draft on this
account**. No bulk-delete endpoint is called anywhere in this codebase, and
`guardrails.ts` snapshots and re-verifies the whole board around every cycle precisely
because of that incident.

## The identifier model (read this before touching metricool.ts)

Metricool gives a post two ids and they behave very differently.

| | `uuid` | `id` |
|---|---|---|
| stability | **stable for the post's life** | **reassigned on every update** |
| type | signed 64-bit int rendered as a string, **can be negative** | integer |
| use | the join key; everything persistent | transient, only for `DELETE` |

Observed: one post's `id` went `353913385 -> 353913396 -> 353913406` across three
mutations while its `uuid` never moved.

**Rules that fall out of this:**

1. **Every persistent store keys on `uuid`, stored as TEXT.** `ab-database.json`
   (`metricool_uuid`), the run state (`videos[].metricool.uuids`), and the board ledger
   all do. Parsing a uuid as a number silently corrupts the negative ones — two of the
   ten current drafts have negative uuids.
2. **Delete must re-read first.** `DELETE` rejects the uuid with **HTTP 500**
   (`Failed to convert String to Integer`) and accepts only the *current* numeric id, so
   `metricool.ts:deletePost` resolves the id immediately before deleting.
3. **That 500 is a permanent client error, not a transient.** Retry logic that treats
   5xx as retryable will loop forever on it. `metricool.ts` does not retry it.

## The traps

**TRAP 1 — `userId` and `blogId` are mandatory but undeclared.** They appear on none of
the spec's 497 paths, and omitting them fails in confusing ways. `metricool.ts` injects
them in the transport layer, never at a call site, so a new endpoint cannot forget them.

**TRAP 2 — TikTok `reach` is NULL on every row.** This is not data loss: Publer's TikTok
"reach" was always plays, and Metricool's `viewCount` is the same number (in
`ab-database.json` every TikTok record has `reach` exactly equal to `video_views`). But a
naive `reach -> reach` mapping returns null, and null reach silently stops the
replication engine from ever firing for TikTok. `tiktokPosts()` maps reach to `viewCount`.

**TRAP 3 — Instagram's `videoViews` is deprecated.** Use `views`. Both `videoViews` and
`videoViewsTotal` are labelled deprecated and will mislead.

**TRAP 4 — the analytics endpoints reject a bare date.** They want a NAIVE local
datetime (`yyyy-MM-dd'T'HH:mm:ss`); a bare date and an ISO offset both return HTTP 400.
`insights.ts:stamp()` normalises whatever a caller passes.

**TRAP 5 — TikTok has no usable watch-time data.** Metricool declares four TikTok
watch-time fields and returns null on all of them, so the 3-second skip rate — the metric
promotion judges hook quality on — exists for Instagram only. TikTok arms can contribute
reach and views but can never be scored on hook quality. Worth knowing before anyone
reads a TikTok skip number as real.

## How the learning loop joins now

Metricool splits the two halves of a post across two APIs that share no id:

- the **planner** (`listPosts`) knows `uuid` and, once published, the provider's
  `publicUrl` — but never the native post id;
- **analytics** (`insights.ts`) knows the native `post_id` and the post's `url` — but
  never the planner uuid.

The permalink is the only field both carry, so it is the join key:

```
ab-database.metricool_uuid -> planner.publicUrl == analytics.url -> platform_post_id
```

`reconcile.ts` does that join and back-fills `platform_post_id` / `permalink` /
`posted_at`. It runs **before** scoring in `cycle.ts`, which is a deliberate change from
the Publer era: Publer's analytics reported its own post id, so scoring could fall back
to it and attach metrics to a just-published post in the same cycle. Metricool's
analytics expose no planner uuid, so the only join is the native `platform_post_id` —
which is exactly what reconcile fills in. Scoring first would cost a day of learning on
every post a human published since the last run.

## What the removal touched (2026-07-28)

Deleted: the Publer REST client and its thin wrapper, the Publer read/draft Node bridges,
the `sffs_publer_read` / `sffs_publer_draft` agent tools and the Python draft guard behind
them, the nine Publer-era one-off ops scripts in `tools/`, the legacy
`hermes/src/dashboard.ts` and the dashboard's "older drafts" panel, and the
`/api/draft-media` proxy.

The proxy is worth a note: it existed **only** because Publer's CDN was Referer-gated and
403'd off-origin. Metricool's is not — verified live, `static.metricool.com` serves the
asset with no Referer, with a hostile Referer, and with a foreign Origin (HTTP 200 every
way) — so the `<video>` now points straight at it and the proxy was removed rather than
left standing as an open-proxy surface. `data.ts` still allowlists every media URL to that
exact host with no query string, so an S3 presigned URL can never reach the public page.

Renamed in place, with the old value preserved rather than dropped:
`publer_post_id -> metricool_uuid` (+ `legacy_publer_post_id` for provenance) and
`videos[].publer -> videos[].metricool` (+ `legacy_publer` for the Publer-era runs).

Nothing was deleted from the A/B history. All 84 `ab-database.json` rows survived; the 15
rows carrying real metrics all still resolve, because they join on `platform_post_id` and
all 15 are present in Metricool's analytics.
