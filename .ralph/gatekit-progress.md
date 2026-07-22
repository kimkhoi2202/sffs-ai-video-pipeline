# gatekit — auto-merge GATE INFRASTRUCTURE (parallel workstream)

> Parallel workstream to the tool-building main line. Built in an ISOLATED git
> worktree so it never collides with `hermes-nous`. Nothing here publishes,
> schedules, deploys, or merges to `main`/`hermes-nous` — the gate's whole job is
> to KEEP the DRAFT-ONLY safety core green + reviewed before any code lands.

- **Worktree:** `/Users/khoilam/hermes-nous-build/wt-gatekit`
- **Branch:** `hermes-nous-gatekit` (forked off `hermes-nous` @ `2ede240`)
- **Repo:** `/Users/khoilam/hermes-nous-build/sffs-ai-video-pipeline`
- **Status:** COMPLETE + all green. Ready for integration into `hermes-nous`.
  Did NOT merge (per rules) — reported as ready.

## What this implements (RALPH_TASK.md criteria 6 + 8 — the TWO-KEY auto-merge gate)

The deployed software factory may auto-merge its OWN code changes ONLY when BOTH
keys are satisfied — fail-closed if either fails:

    KEY 1  the E2E harness is GREEN, AND
    KEY 2  an independent review agent APPROVES.

All new files live under `hermes-nous/scripts/gate/**` and `hermes-nous/tests/e2e/**`.

### 1. E2E harness — `scripts/gate/harness.py` (+ `sffs_selfcheck.py`)  [KEY 1]
Runs three legs and returns ONE machine-readable GREEN/RED verdict:
  - **pytest** — auto-discovers every top-level `hermes-nous/tests/test_*.py` (so
    new main-line tools' tests are picked up automatically; the gate's own
    `tests/e2e/` is excluded to avoid self-recursion).
  - **Node bridge dry-run matrix** — actually runs the 3 TS bridges in `--dry-run`
    (12 cases) proving they run network-free AND the Node layer refuses non-draft
    `state`/`scheduled_at` and exposes no publish/schedule/delete subcommand.
  - **sffs_selfcheck** — loads the plugin via its real `register()`, lists tools,
    and drives the `pre_tool_call` publish guard against a known BLOCK/ALLOW
    matrix (15 block + 11 allow). Requires the safety core + read tools, forbids
    any publish/schedule/delete tool name, and TOLERATES new main-line tools.

### 2. Review agent — `scripts/gate/review_agent.py`  [KEY 2]
A fresh Nous subagent (a `hermes -z` oneshot by default = no parent history =
independent of the author; wire to `delegate_task` at runtime via
`SFFS_REVIEW_MODEL_CMD`) that reviews a diff for correctness + SAFETY and returns
APPROVE/REJECT. Two layers, both required to APPROVE:
  - **Static safety floor (deterministic, no model):** scans the diff for an
    introduced publish/schedule/delete/mutate path, a non-draft state being set,
    or DRAFT-ONLY tampering. A hit = immediate REJECT (no model call). Scoped to
    production code (tests/docs exempt); verified to have ZERO false positives on
    the real guard code and to catch every malicious/tamper class.
  - **Fresh model review** for correctness/scope + a second safety opinion.
Fail-closed: empty diff, static hit, model error/timeout, or an unparseable
verdict all → REJECT.

### 3. Two-key gate — `scripts/gate/auto_merge.py`
Merges `--source` into `--target` ONLY if `decide(harness GREEN AND review
APPROVE AND mergeable AND no-guard-failure)`. Otherwise refuses + logs (JSONL).
  - **Guards (fail-closed):** kill-switch (`SFFS_FACTORY_KILL` / stop-file),
    protected-branch (never `main`/`master`/`prod`…), scope (deny-globs).
  - **Merge mechanics:** stages the merge in an EPHEMERAL detached worktree so
    the harness runs on the real MERGED tree; the target branch is advanced with
    a compare-and-swap `update-ref` only on success; any failure aborts +
    removes the worktree (target untouched).
  - **Default = dry-run** (safe anywhere); `--execute` performs the real merge.

Convenience wrapper: `scripts/gate/run-gate.sh {harness|selfcheck|review|merge|test}`.

## Test results (all green)
- Full `pytest hermes-nous/tests`: **291 passed** (214 existing tool suite + 77 new gate e2e).
- `harness.py`: **GREEN** — pytest (4 files) + node 12/12 + selfcheck (15/15 block, 11/11 allow).
- Gate e2e (`tests/e2e/`, 77 tests): selfcheck, harness legs, review static-scan
  robustness (no FP on real guard code; every malicious class caught) + fail-closed
  verdict logic, and the two-key `decide` truth-table + real git merge mechanics
  (dry-run never moves target; execute advances only on green+approve; conflict/
  protected/kill-switch/scope all refuse), plus one REAL end-to-end (actual harness +
  review agent through a real git merge on a fresh clone → dry-run MERGE).

## Collision safety (STRICT rules honored)
- Touched ONLY new `hermes-nous/scripts/gate/**` + `hermes-nous/tests/e2e/**`.
- Modified ZERO tracked files. Did NOT touch `sffs/__init__.py`, `sffs/plugin.yaml`,
  `sffs/schemas.py`, the tool files, the bridges, `config`, existing tests, or
  `.ralph/state.md` / `.ralph/progress.md` (main line owns those).
- DRAFT-ONLY preserved (gate introduces no publish path). No push to `main`; no
  merge into `hermes-nous`; no prod/VPS touch; secrets stay out of git.

## Note for integration
- The worktree forked at `2ede240`; the main line has since added tools
  (`sffs_design`, `sffs_gates`, `sffs_questions`). The gate already tolerates them
  (required-subset + auto-discovered tests), verified against the current tip via
  the real-integration test. When integrating, a plain `git merge hermes-nous-gatekit`
  into `hermes-nous` adds only the two new directories — no conflicts expected.
