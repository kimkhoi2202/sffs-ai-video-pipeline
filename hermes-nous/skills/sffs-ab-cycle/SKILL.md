---
name: sffs-ab-cycle
description: "Run ONE full DRAFT-ONLY SFFS A/B quiz-video cycle end to end (score -> design -> gates -> render -> S3 -> Publer DRAFTS), and fold results back into the durable A/B memory. Use for the nightly sffs-nightly cron job or an on-demand cycle."
version: 1.0.0
author: hermes-nous rebuild (ralph-wiggum overnight build)
license: MIT
metadata:
  hermes:
    tags: [sffs, ab-testing, draft-only, video, cron, quiz]
---

# SFFS A/B cycle (DRAFT-ONLY)

You are running the autonomous **Smart Fella or Fart Smella** quiz-video loop, rebuilt on
Hermes. One cycle designs a batch of short quiz videos — each testing a different A/B
dimension — renders them, hosts the media on S3, and creates **Publer DRAFTS** for a human
to review and post. It then folds fresh performance data back into the loop's memory so the
next batch is smarter.

## THE FROZEN INVARIANT — read this first, every time

- **DRAFT-ONLY. You may ONLY create Publer *drafts*.** You may NEVER publish or schedule a
  live post. Going live is a **human** action, forever. Use `sffs_publer_draft` (it can only
  ever create drafts). Never call any `*publish*`, `*schedule*`, `*post_now*`, `*go_live*`,
  `update_post`, or `delete_post` tool — the framework guard will refuse them anyway.
- **Do not touch existing posts.** Snapshot the existing scheduled + published posts BEFORE
  the batch and verify them unchanged AFTER. The loop only ever ADDS new drafts.
- **Never push to `main`.** The cycle tool forces this off; do not run raw `git push`.
- **Media = S3.** Rendered mp4s go to the private S3 bucket (presigned GET); not Supabase.
- **Quality > volume.** Every gate is fail-closed — if a video can't pass, DROP it, never
  weaken a gate to force it through.

## The fast path — one tool

For a normal run, call **`sffs_cycle`** — it runs the whole sequence below and returns a
summary (per-video status, drafts created, do-not-touch verified):

- `sffs_cycle { "dry_run": true, "target": 10 }` — design + gate + render the batch, but
  create NO drafts and upload nothing (a safe end-to-end dry-run). Start here.
- `sffs_cycle { "dry_run": false, "target": 10 }` — a REAL draft-only cycle: also uploads to
  S3 and creates Publer DRAFTS. Still never publishes/schedules; still never pushes to main.
- `sffs_cycle { "preview": true }` — just show the resolved run config; run nothing.

Re-running the same `run_id` (default: today's UTC date) RESUMES — completed per-video steps
are skipped. This is idempotent and safe to retry.

## The granular path — step by step (what `sffs_cycle` does internally)

Use these when you want to drive or debug one stage at a time. Do them IN THIS ORDER:

1. **Refresh memory (scoring).** `sffs_score_rollup { "dry_run": false }` — pull matured
   Publer analytics (~24h lag, last 30 days), refresh `ab-database.json` metrics, and
   recompute `learnings.json` rollups + front-runners (now including `by_variant_arm`, the
   per-arm rollup the default-promotion read-side needs). (Read-only vs `sffs_score`, which
   never writes.) This is what makes the loop self-improving across runs.

1b. **Detect default promotions (read-only).** `sffs_promote { "action": "detect" }` — re-scan
   `learnings.json` and record a PROPOSAL whenever a test ARM clearly beats the current
   default (control) on the configured metric with enough samples. This ONLY writes the
   proposals queue (`ab-testing/proposals.json`); it NEVER flips a default. Flipping a
   default is a HUMAN action via `sffs_promote_default --approve <id>` (see "Default
   promotions" below) — you may detect + surface, never approve.
2. **Snapshot do-not-touch.** `sffs_donottouch_snapshot {}` — capture the ids of every
   existing scheduled + published post. Keep the returned `snapshot`.
3. **Design the batch.** `sffs_design { "what": "plan", "run_id": "<date>", "target": 10 }`
   — one video per A/B dimension, biased by `learnings.json` front-runners, with FRESH
   never-repeated questions and on-brand gated captions. **Every video gets the current
   DEFAULTS unless it is the arm under test:** narration defaults to `full` (narrate every
   video) and the ending defaults to `cliffhanger` (reveal the early questions, withhold the
   last + comment-CTA, no score screen; on a 1-question video this collapses to withholding
   that single verdict + comment-CTA). The **control/baseline** video is exactly full
   narration + cliffhanger. Arms DEVIATE one axis from those defaults: the narration family
   (`no-narration` / `no-question-vo` / `no-options-vo`) tests the narration axis; the ending
   family (`full-reveal` / `no-answer`) tests the ending axis; progress-counter / tempo /
   length / category-mix / hook test their own axis while keeping both defaults. The current
   defaults live in `ab-testing/content-defaults.json`. (`what: "catalog"` lists the whole
   A/B space with no LLM call — control has `deviates:"none"`, arms show which axis they test.)
4. **For each planned video**, fail-closed:
   a. `sffs_gates { "what": "dedup", ... }` — never-repeat check. Fail -> DROP.
   b. `sffs_gates { "what": "validity", ... }` — LLM rubric (one unambiguous answer, factual,
      grade-appropriate). Fail -> DROP (leave the questions UNUSED).
   c. **Mark used ONLY after validity passes** (this happens inside `sffs_cycle`; when driving
      manually, the drafting step owns the mark-used write — do NOT mark selection-time).
   d. `sffs_gates { "what": "copy", ... }` — brand-voice + kid-safe on caption/on-screen text.
      Fail -> DROP.
   e. `sffs_render { "id": "<video id>", "props": <plan.props> }` — render the 1080x1920 mp4;
      synthesizes cloned-voice narration for voiced arms.
   f. `sffs_gates { "what": "render", "path": <render path>, "expected_frames": <n> }` — ffprobe
      sanity (resolution, audio, duration). Fail -> DROP.
   g. `sffs_upload_s3 { "local_path": <render path> }` — host the mp4, get a presigned GET URL.
   h. `sffs_publer_draft { "account_ids": [...], "text": <caption>, "media_ids": [...] }` —
      create the Publer DRAFT (the ONLY sanctioned write; it can never publish/schedule).
5. **Verify do-not-touch.** `sffs_donottouch_verify { "snapshot": <from step 2> }` — prove no
   pre-existing scheduled/published post was changed. If it reports a violation, STOP and flag.

## Memory (self-improving across runs)

- The durable A/B memory is `ab-testing/ab-database.json` (per-post variant + metrics) and
  `ab-testing/learnings.json` (rollups + front-runners). `sffs_score_rollup` refreshes them
  each cycle; `sffs_design` reads `learnings.json` to bias the next batch. This is how the
  loop learns which A/B arms win over time.
- Also record a one-line takeaway of each cycle (drafts created, any new front-runner) in your
  own MEMORY so future runs have the narrative, not just the numbers.

## Default promotions (HUMAN-gated — the content analog of the code gate)

The loop A/B-tests every axis against the current DEFAULT (the control). When a test arm
clearly beats the default, that is a candidate to become the NEW default — but flipping a
default is a **human** action, never the loop's (the content analog of the software factory's
two-key CODE gate, kept clearly separate from it):

- **Detect (you, read-only):** `sffs_promote { "action": "detect" }` scans `learnings.json`
  `rollups.by_variant_arm` and records a proposal in `ab-testing/proposals.json` when an arm
  beats the control by the config-driven margin (default: `median_eng_rate`, `min_sample` 5 on
  BOTH sides, `+1.0pp` absolute AND `+20%` relative). Thresholds live in
  `ab-testing/content-defaults.json` → `promotion`. `sffs_promote { "action": "list" }` shows
  pending proposals; `"show"`/`"status"` for details. **You may detect + surface only.**
- **Approve/reject (HUMAN, in a shell):** a human runs
  `hermes-nous/scripts/sffs_promote_default --approve <id>` to flip the config default (takes
  effect next design pass, logged to `content-defaults.json` history + `learnings.json`
  decisions), or `--reject <id> --reason "…"` to keep the arm testing. The autonomous agent
  and the `sffs_promote` tool can NEVER approve — the tool refuses approve/reject and points to
  the CLI. Pending proposals also show on the read-only dashboard ("Pending default changes").

## Cadence

Run on a **~24h** cadence (`sffs-nightly` cron), aligned to Publer's ~24h analytics lag so each
run scores yesterday's posts before designing today's batch.
