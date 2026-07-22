# READINESS — `hermes-nous` SFFS agent: what's built, what's proven, how to go live

> **STATUS: FEATURE-COMPLETE + END-TO-END VALIDATED. NOT DEPLOYED.**
> The rebuilt DRAFT-ONLY A/B quiz-video agent (NousResearch `hermes-agent`
> framework + the `sffs` plugin) is done and proven on branch `hermes-nous`.
> Nothing is on the VPS. Cutover is **human-gated** → see [`ops/CUTOVER.md`](./CUTOVER.md).
> The live production loop on `main` (`ef7f731`) was never touched and keeps drafting.

Last updated: iteration 9 (2026-07-22).

---

## 1. What's BUILT

The current SFFS pipeline (`hermes/src/*.ts`) is now driven by the Nous agent
framework via a Hermes **plugin** (`hermes-nous/sffs/`) that WRAPS the proven TS
modules (never reimplements them), plus skills, a cron, a cost governor, a
software factory, and a read-only dashboard.

- **13 `sffs` tools** (one plugin, `plugin.yaml` v0.12.0):
  `sffs_cycle` · `sffs_design` · `sffs_gates` · `sffs_questions` · `sffs_render`
  (Remotion + cloned-voice narration A/B arms) · `sffs_upload_s3` ·
  `sffs_publer_read` · `sffs_score` · `sffs_score_rollup` · `sffs_publer_draft` ·
  `sffs_donottouch_snapshot` · `sffs_donottouch_verify` · `sffs_factory`.
- **DRAFT-ONLY safety core (belt + suspenders + hook):** Python belt
  (`draft_guard.py`), Node suspenders (`createDraftOnly` in `guardrails.ts`), and
  a framework `pre_tool_call` publish guard (`publish_guard.py`) that hard-blocks
  any publish / schedule / go-live / delete / update / non-draft-state intent
  across ALL tools (incl. any Publer MCP). Do-not-touch snapshot/verify brackets
  every cycle. No schedule/publish/delete/update path is imported anywhere.
- **Autonomous cycle:** `sffs_cycle` (wraps `cycle.ts runCycle`) + the
  `sffs-ab-cycle` skill + framework `MEMORY.md` + the durable A/B memory
  (`ab-database.json` / `learnings.json`, refreshed by `sffs_score_rollup`, read
  by `sffs_design`). The sandbox cycle ALWAYS forces `HERMES_SKIP_GIT=1` (can
  never push to `main`).
- **Two-key auto-merge gate** (`scripts/gate/`): KEY 1 = the E2E `harness` GREEN,
  KEY 2 = an independent full-model `review_agent` APPROVE. Fail-closed.
- **Software factory** (`sffs_factory` + `sffs-software-factory` skill): fans out
  code-change workstreams to `delegate_task` subagents and auto-merges each ONLY
  through the two-key gate, scoped (deny-globs `ops/**`, `*.pem/*.key/*.env`),
  never a protected branch, with a rollback point per merge.
- **Cost governor + kill-switch** (`cost_governor.py`): AGGRESSIVE-BUT-BOUNDED —
  HIGH but finite ceilings ($75/day, 40M tok/day, 8 concurrent children, 500
  spawns/day; env-overridable) + one shared kill-switch (env `SFFS_FACTORY_KILL`
  or a stop-file). A SPEND brake only — orthogonal to the DRAFT-ONLY belt.
- **Read-only supervisor dashboard** (`dashboard/`, port 8081): cycle status +
  A/B results + software-factory PR view (review verdict + CI) + a display-only
  kill-switch indicator. Never posts, never merges.
- **`sffs-nightly` cron — registered PAUSED** (`enabled:false, state:"paused"`;
  `hermes cron list` hides paused jobs). Nothing fires until a human resumes it.
- **Human-gated cutover plan:** [`ops/CUTOVER.md`](./CUTOVER.md) (documented, NOT executed).

---

## 2. What's PROVEN

### Automated suite (all GREEN, post-merge)
- **628 pytest** (hermetic: no network/node/framework) — `pytest hermes-nous/tests`.
- **Gate harness GREEN** (`scripts/gate/harness.py`): pytest 14 files · node bridge
  dry-run matrix 12/12 · `sffs_selfcheck` 15/15 block + 11/11 allow.
- **14 dashboard node tests** (`node --test` in `hermes-nous/dashboard`).
- Both prior end-to-end DRY-RUNs: the full cycle (iter-7, 2 videos rendered) and
  the factory through the REAL two-key gate (iter-8, no merge).

### LEG A — one REAL DRAFT-ONLY cycle (live, bounded, tagged)
`sffs_cycle {dry_run:false, target:2}`, run_id `hermes-nous-validation-1784703162`.
The full chain ran live: score (14 pulled/updated) → design (rotating dims: picked
`narration/full-narration` + `tempo/fast-3s`) → dedup/validity/copy gates → mark-used
→ render (incl. a cloned-voice narrated mp4) → render-sanity → **S3 presigned upload**
→ **Publer DRAFT** → annotate.

- **Real Publer DRAFTS created (state=`draft`), tagged `[hermes-nous validation]`:**
  - `6a60690be6d05c066be43f5e`
  - `6a60690be6d05c066be43f5c`
  - (one drafted video → one draft per account: Instagram + TikTok. Draft count 20 → 22.)
  - **Please delete these two validation drafts in Publer** (find by the tag).
- **v02 was correctly REJECTED** by the fail-closed question-validity gate (quality > volume).
- **Do-not-touch UNTOUCHED:** 6 scheduled + 23 published, verified unchanged by BOTH
  the cycle's internal `verifyDoNotTouch` AND an independent snapshot/verify (`{verified:true}`).
- **git skipped** (`git.note = "skipped (HERMES_SKIP_GIT=1)"`) — no push to `main`.
- **Nothing published or scheduled** — draft state only. In-repo data files the cycle
  mutated (`ab-database.json`/`learnings.json`/`ab-test-usage.json`) were restored; the
  fresh questions used are recorded in the isolated `hermes-used-sigs.json` (no VPS collision).

### LEG B — one LIVE software-factory auto-merge into `hermes-nous`
`sffs_factory {source:"sffs-factory/harden-slugify", execute:true, dry_run:false, offline_review:false}`.
The change: a real robustness fix — `factory.slugify` now trims a trailing hyphen after
truncation so workstream branch names are always clean — plus `tests/test_factory_slugify.py`.

- **KEY 1 (harness): GREEN** (551 pytest on the merged tree · node 12/12 · selfcheck 15+11).
- **KEY 2 (review): APPROVE** — `source: static+model`; the fresh independent full-model
  review (`hermes -z`, no author history) returned `VERDICT: APPROVE` (static safety clean,
  correct, in-scope, tests green).
- **MERGED into `hermes-nous` ONLY** — merge commit **`1ddfe515cccc261278b0fd3f93feae0d8c3bd4f0`**
  (parents `73c7e3b` + `5e7c8fe`), advanced by compare-and-swap `update-ref`.
- **Rollback retained:** previous tip `73c7e3b` (`git update-ref refs/heads/hermes-nous 73c7e3b`).
- Fleet = 1 (one prepared branch); cost governor pre-flight passed; kill-switch honored.
- **`main` untouched (`ef7f731`).**

---

## 3. Completion criteria (RALPH_TASK.md) — ALL MET

1. Nous agent installed + TrueFoundry (`claude-opus-4-8`) provider wired — **DONE**.
2. Every pipeline feature (render + **narration** A/B arms, score, design, gates, S3,
   Publer draft) wrapped as `sffs` tools — **DONE**.
3. Autonomous DRAFT-ONLY cycle via cron + memory — **DONE** (cron PAUSED for cutover; ran live in LEG A).
4. Dashboard incl. cycle + code-change/PR view — **DONE**.
5. DRAFT-ONLY + do-not-touch enforced + tested (belt/suspenders/hook) — **DONE** (LEG A live proof).
6. Software factory: auto-merge on the TWO-KEY gate (green tests AND review-agent) —
   **DONE + LIVE-PROVEN** (LEG B real merge `1ddfe51`).
7. Full code control via the plugin/tools + the factory — **DONE**.
8. End-to-end tested + working (the harness = KEY 1) — **DONE** (628 pytest + harness + both live legs).
9. Isolated + a documented, human-gated cutover plan (NOT executed) — **DONE** ([`ops/CUTOVER.md`](./CUTOVER.md)).

**All RALPH_TASK completion criteria are MET (feature-complete + E2E-validated).**

---

## 4. The one human action to go live (cutover)

Nothing deploys itself. To put this agent on the VPS, a human follows
**[`ops/CUTOVER.md`](./CUTOVER.md)** end to end (resize to a `c6i.4xlarge`–`8xlarge`
— NOT GPU / not 7th-gen — instance-role S3, env/keys incl. the kill-switch, the
systemd swap, verification), and the go-live action is:

```bash
hermes cron resume sffs-nightly     # activates the ~24h DRAFT-ONLY cycle
```

Rollback and post-cutover guardrails are in `ops/CUTOVER.md`. Even after cutover the
agent stays DRAFT-ONLY (code autonomy ≠ posting autonomy) and the factory only
auto-merges on green tests + review, never to `main`, honoring the kill-switch.

---

## 5. Honest caveats
- The cost **$/token** figure is a conservative ESTIMATE (the TrueFoundry provider
  doesn't surface usage to the framework); the kill-switch, concurrency cap, and
  spawn cap are EXACT.
- LEG A left **2 tagged validation drafts** in Publer — delete them (see §2).
- The `hermes-nous-gatekit` / `hermes-nous-dashboard` branch refs are already merged
  and may be deleted at will.
