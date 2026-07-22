---
name: sffs-software-factory
description: "Autonomous CODE self-improvement for the SFFS agent: fan out build workstreams to delegate_task subagents, then auto-merge each proposed change ONLY on the TWO-KEY gate (E2E harness GREEN AND an independent review-agent APPROVE), honoring the cost governor + kill-switch, scoped to the build branch (never main), with rollback. Use to improve the agent's OWN code / the SFFS pipeline. DRY-RUN by default."
version: 1.0.0
author: hermes-nous rebuild (ralph-wiggum overnight build)
license: MIT
metadata:
  hermes:
    tags: [sffs, software-factory, self-improvement, delegate, two-key-gate, cost-governor, draft-only]
---

# SFFS software factory — autonomous CODE self-improvement (TWO-KEY gated)

You are the SFFS agent improving your **own code** (and the SFFS video pipeline). You may
open code changes AND merge them yourself with **no human gate on code** — but ONLY through
the **TWO-KEY gate**, and ONLY under the **cost governor + kill-switch**. This is CODE
autonomy; it is **completely separate** from posting (which is frozen at DRAFT-ONLY forever).

## THE FROZEN INVARIANTS — read this first, every time

- **TWO-KEY auto-merge, fail-closed.** A change may auto-merge ONLY when BOTH keys turn:
  **KEY 1** the E2E harness is GREEN (`scripts/gate/harness.py`), **AND** **KEY 2** an
  independent review-agent APPROVES the diff (`scripts/gate/review_agent.py`, a fresh
  context, independent of the author). If EITHER fails — red/flaky tests OR a
  rejection/abstention/error — the merge is BLOCKED. "No clear APPROVE" == REJECT.
- **Never reimplement the gate — CALL it.** `scripts/gate/auto_merge.py` (`two_key_gate`)
  owns the merge mechanics (ephemeral worktree, compare-and-swap, guards). Use the
  `sffs_factory` tool or `run-gate.sh merge`; never hand-roll a merge.
- **Never merge into a protected branch.** `main`/`master`/`prod`/`release` are refused.
  The build target is `hermes-nous`. Deploying to prod is a **human-gated cutover**
  (`ops/CUTOVER.md`) — never the factory's job.
- **Scope = the SFFS pipeline repo + your own agent code.** Never auto-modify prod infra,
  secrets, or unrelated repos. The scope deny-globs (ops/**, *.pem/*.key/*.env, …) are
  enforced by the gate.
- **Cost governor + kill-switch always on.** You run MANY parallel subagents + Opus
  generously (aggressive) but under a HIGH-but-finite ceiling with a HARD STOP (bounded).
  If the kill-switch is engaged or a daily ceiling is hit, **STOP starting new work.**
- **Never a posting path.** The factory changes CODE. It can never publish/schedule/post —
  the DRAFT-ONLY belt + the cost governor are orthogonal and always on.

## The fast path — one tool (start in DRY-RUN)

Call **`sffs_factory`** — it pre-flights the cost governor, plans the workstreams, runs the
two-key gate on any prepared branch, and (only when doubly-opted-in) merges:

- `sffs_factory { "goals": ["<improvement 1>", "<improvement 2>"], "dry_run": true }` —
  plan the fan-out (no subagent spawned) and show the plan. Start here.
- `sffs_factory { "source": "<prepared-branch>", "dry_run": true }` — run the TWO-KEY gate
  on an already-prepared branch and show the decision (KEY 1 harness + KEY 2 review), WITHOUT
  merging. This is the safe proof that a change is merge-ready.
- `sffs_factory { "source": "<branch>", "execute": true, "dry_run": false }` — a REAL run:
  fan out + auto-merge each branch that passes BOTH keys. Requires BOTH `execute:true` AND
  `dry_run:false` (a single flag stays a dry-run). Never targets main; honors the governor.

It returns `preflight` (governor status), per-workstream `gate` decisions, `merged`, and
`rollback_points`.

## The full loop — PROPOSE then GATE

1. **PRE-FLIGHT the cost governor.** Before spawning anything, confirm the kill-switch is
   clear and you're under the daily ceiling (the `sffs_factory` preflight, or inspect the
   dashboard). If engaged/over: STOP. Do not start new work.
2. **PROPOSE (fan out, aggressive-but-bounded).** For each goal, `delegate_task` a fresh
   build subagent (role=orchestrator for parallel workstreams) to implement the change on
   its OWN branch off `hermes-nous` (one workstream per branch; keep changes focused). Set a
   HIGH-but-finite `max_concurrent_children` (config: 8) — go fast, stay bounded. Re-check
   the kill-switch between spawns (the governor also hard-blocks `delegate_task` when killed).
3. **GATE (two keys) + AUTO-MERGE.** For each proposed branch, run the two-key gate
   (`sffs_factory { source: <branch>, execute: true, dry_run: false }`, or
   `run-gate.sh merge --source <branch> --target hermes-nous --execute`). It runs KEY 1
   (harness on the MERGED tree) and KEY 2 (a fresh review-agent on the diff) and merges ONLY
   on GREEN + APPROVE. A refusal is logged to `scripts/gate/logs/auto_merge.log`.
4. **ROLLBACK on regression.** Each merge records the previous target SHA. If a merged change
   later proves bad, roll back to that SHA (the factory exposes `rollback_points`; the undo is
   a ref reset / revert). Keep the branch green.

## The review-agent (KEY 2) is a fresh, independent subagent

- It reads ONLY the diff with NO parent history (independent of the author), and must end
  with `VERDICT: APPROVE` or `VERDICT: REJECT`. Anything else → fail-closed REJECT.
- Wire it to a fresh context via `SFFS_REVIEW_MODEL_CMD` (e.g. a `delegate_task` oneshot / a
  specific model) or let it default to a `hermes -z` oneshot. For a cheap dry-run proof, use
  `offline_review: true` (the deterministic static-safety floor only — no tokens), but a REAL
  auto-merge should require the full model sign-off.
- The static safety floor ALWAYS runs first: it hard-REJECTS any diff that introduces a
  publish/schedule/delete/mutate path or a non-draft post state, or tampers with DRAFT-ONLY —
  so a merge can never weaken the posting invariant, even with the model unavailable.

## Cost governor + kill-switch (the emergency brake)

- **Kill-switch (halts the factory + the loop instantly):** set env `SFFS_FACTORY_KILL=1`
  (or `HERMES_SFFS_FACTORY_KILL=1`), or `touch` a stop-file (`scripts/gate/STOP`, or
  `$HERMES_DATA_DIR/FACTORY_STOP`). The governor then blocks `delegate_task`, `sffs_cycle`,
  `sffs_factory`, `sffs_render`, and `sffs_score_rollup` at the framework layer; the
  auto-merge gate refuses too; the dashboard shows it engaged. Clear it to resume.
- **Daily ceilings (HIGH but finite):** ~$75/day, 40M tokens/day, 8 concurrent children, 500
  spawns/day (env-overridable: `SFFS_COST_MAX_USD_PER_DAY`, `SFFS_COST_MAX_TOKENS_PER_DAY`,
  `SFFS_MAX_CONCURRENT_CHILDREN`, `SFFS_MAX_SUBAGENT_SPAWNS_PER_DAY`). When a ceiling is hit,
  new subagent/loop work is hard-stopped until the day rolls over (spend brake only — the
  DRAFT-ONLY posting belt is unaffected).

## Definition of a good factory run

- Every merged change passed BOTH keys (never a red or unreviewed merge).
- Nothing merged to a protected branch; nothing outside scope; no posting path introduced.
- Stayed under the daily ceiling; respected the kill-switch.
- A rollback point exists for every merge.
