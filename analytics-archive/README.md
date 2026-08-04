# analytics-archive

A durable, append-only record of what Metricool will still tell us about what we published.

## Why this directory exists

**Metricool's analytics API serves a rolling window of roughly fourteen days, and it does
not say so.** A request for June returns `[]` with HTTP 200 — indistinguishable from
"nothing was published in June". Measured 2026-08-04:

| request | rows |
|---|---|
| 2026-06-01 → 2026-06-30 | 0 |
| 2026-07-01 → 2026-07-14 | 0 |
| full year | 126 (earliest `2026-07-20T01:12:18` Europe/Madrid) |

Every finding this campaign rests on is computed against a window that erases its own
oldest day, every day, silently. The Jul 23–28 attribution blackout is already permanent
for exactly this reason. Nothing here recovers that. The point is that it stops from
2026-08-04 onward.

## What a snapshot contains

`hermes/src/analyticsArchive.ts` writes one JSON document per capture:

- **`sources.<name>.rows`** — the payload **verbatim**. No projection, no renaming, no
  dropped keys. The loop's own readers are lossy on purpose (`instagramReels()` keeps 13
  of a reel row's 20 fields); an archive must not be. Among the seven fields only the
  archive carries is `content`, the published caption — the last join key a post has
  once the scheduler forgets its uuid.
- **`sources.<name>.time_index`** — additive, never a replacement. Each row's timestamp
  resolved to a true instant (`utc`), the same moment on the account's posting clock
  (`account`, offset attached), the zone the row **declared**, and a `zone_assumed` flag
  when nothing declared one. Metricool answers on the **brand's** clock (Europe/Madrid
  here) whatever zone was requested, so the naive `dateTime` alone is not a usable time —
  reading it as written is what filed a 00:21 Chicago reel under "morning".
- **`coverage`** — how far back each source actually reached on that capture.

`schedulerPosts` is archived alongside the analytics because it forgets **faster**: on
2026-08-03, 21 of the opening experiment's 41 posts had already fallen off
`/v2/scheduler/posts`, which is what broke the uuid → permalink → skip-rate join.

## Where snapshots go

Two places, because neither is sufficient alone — this box's predecessor was terminated
with work on it, and the repo is ~102 commits ahead of an origin it cannot safely push to.

```
disk   ~/hermes-data/analytics-archive/dt=<YYYY-MM-DD>/snapshot-<instant>.json
s3     s3://hermes-sffs-media/hermes/analytics-archive/dt=<YYYY-MM-DD>/snapshot-<instant>.json
```

Every key carries its own capture instant, so **no run can address another run's object**
— overwriting is not merely discouraged, it is unaddressable. Both writers also refuse
explicitly: the disk writer opens with `wx`, and the S3 writer HEADs first and passes
`If-None-Match: *`. Nothing in this path ever deletes.

`~/hermes-data/analytics-archive/index.ndjson` is an append-only ledger of every snapshot
taken.

## Cadence

`hermes-analytics-archive.timer` runs daily at 09:17 UTC (`Persistent=true`, so a missed
day catches up). Daily against a ~14-day window is a 14× margin: the archive would have to
miss thirteen consecutive runs before one day of history could be lost. 09:17 UTC avoids
both existing timers — `hermes-nous-loop` at 14:00 and `hermes-reslot` on :00/:30.

The timer deliberately does **not** git-commit. A daily automatic commit would compound
the unpushed-commit backlog this box already carries, and S3 is the copy that outlives the
box anyway.

## Reading one

```bash
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");
         const d=JSON.parse(s); console.log(d.coverage)' <snapshot.json>
```

The committed snapshot in this directory is the first capture (2026-08-04T00:17:07Z). Later
ones live on disk and in S3 only.
