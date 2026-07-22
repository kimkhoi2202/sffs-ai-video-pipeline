# hermes-nous — SFFS agent rebuilt on the Nous Hermes framework

This directory holds the **in-progress** re-base of the SFFS autonomous DRAFT-ONLY A/B video agent
(currently `hermes/`) onto the open-source [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
framework, using that framework's cron learning loop, memory, skills, subagents, and dashboard.

> Status: **iteration 3 (full DRAFT-ONLY safety core landed: draft-only write + do-not-touch reads +
> framework-layer publish/schedule hook)**. Nothing here is deployed. The live loop in `hermes/` on
> `main` keeps running untouched. This work lives ONLY on the `hermes-nous` branch. Cutover is human-gated.

## Two autonomy domains (do not conflate)
- **CODE = high autonomy (the "software factory").** The deployed agent opens PRs for its own code and
  auto-merges them itself — but ONLY on a **TWO-KEY gate**: GREEN CI/E2E tests **AND** an independent
  **review-agent** approval (fail-closed if either fails). Scoped to this pipeline + the agent's own
  code, with a rollback path + kill-switch. Parallelized **aggressively-but-bounded** via Nous
  `delegate_task` subagents (high concurrency ceiling + a hard-stop cost governor + kill-switch, never
  unbounded — this runs on a shared company sandbox).
- **SOCIAL POSTING = draft-only, human-gated, physically enforced.** The agent may only create Publer
  DRAFTS; it can never publish or schedule a live post. Enforced in THREE layers: the Python draft belt,
  the Node `createDraftOnly` suspenders, AND a `pre_tool_call` hook that refuses publish/schedule intent
  across ALL tools (incl. any Publer MCP). Code autonomy does NOT grant posting autonomy.

## Layout
- `config/config.yaml.example` — Hermes config pointing the `custom` provider at TrueFoundry
  (`claude-opus-4-8`). Copy to an ISOLATED `$HERMES_HOME/config.yaml`. NOTE: the `custom` provider does
  not read `OPENAI_API_KEY` on its own, so the example feeds it via `api_key: "${OPENAI_API_KEY}"`
  (expanded from `$HERMES_HOME/.env` — keeps the secret out of git).
- `config/hermes.env.example` — required secret var names (TrueFoundry, Publer, S3, ElevenLabs, GitHub).
  Real values go in `$HERMES_HOME/.env` only — NEVER in git.
- `scripts/hello-model.sh` — proves the TrueFoundry wiring (200=pong with a key; 401=wiring OK, key
  missing).
- `scripts/link-plugin.sh` — symlink the `sffs` plugin into `$HERMES_HOME/plugins/` and enable it
  (idempotent; touches only the untracked `$HERMES_HOME`).
- `scripts/run-tests.sh` — run the Python test suite in the isolated venv (the gate for auto-merge).
- `sffs/` — the `sffs` Hermes **plugin**. Registers three tools + one hook (the DRAFT-ONLY safety core):
  - `sffs_publer_draft` (write, draft-only) — `draft_guard.py` belt + `bridge/publer-draft.ts` suspenders.
  - `sffs_donottouch_snapshot` / `sffs_donottouch_verify` (READ-ONLY) — `donottouch.py` +
    `bridge/donottouch.ts`; snapshot the existing scheduled+published posts before a cycle and verify none
    were touched after (wraps `guardrails.ts` `snapshotDoNotTouch`/`verifyDoNotTouch`).
  - `pre_tool_call` hook — `publish_guard.py`; defense-in-depth that HARD-REFUSES any tool call (ours,
    future, or Publer MCP) carrying publish/schedule/go-live/post-mutation intent.
- `bridge/publer-draft.ts` — Node entry for the draft write path (`--dry-run` = no network / no keys).
- `bridge/donottouch.ts` — READ-ONLY Node entry for snapshot/verify (imports only the two read functions).
- `tests/` — hermetic suites (no network / no node / no framework), **154 tests**, the auto-merge gate:
  `test_draft_only.py` (41), `test_publish_guard.py` (hook refusal + no-false-positive), `test_donottouch.py`.
- `skills/` — skill playbooks (later iterations).

## Quick start (isolated, local)
```bash
# from the workspace root /Users/khoilam/hermes-nous-build
source .venv-hermes/bin/activate
export HERMES_HOME=/Users/khoilam/hermes-nous-build/.hermes-home
# drop the TrueFoundry key into $HERMES_HOME/.env as OPENAI_API_KEY=... (untracked), then:
bash sffs-ai-video-pipeline/hermes-nous/scripts/hello-model.sh          # 200 = pong
hermes chat -q "Reply with exactly the single word: pong"               # full agent-loop pong

# DRAFT-ONLY safety core:
bash sffs-ai-video-pipeline/hermes-nous/scripts/run-tests.sh            # 154 passed (gates auto-merge)
bash sffs-ai-video-pipeline/hermes-nous/scripts/link-plugin.sh          # symlink + enable the plugin
hermes tools list | rg sffs                                            # -> ✓ enabled  sffs  🔌 Sffs
# authoritative per-tool + hook check:
#   registry.get_tool_names_for_toolset('sffs') -> the 3 tools above
#   get_pre_tool_call_directive('publer_publish_post_now', {...}) -> ('block', ...)

# network-free proof the Node bridges only ever read / draft:
echo '{"account_ids":["a"],"text":"hi"}' | \
  node sffs-ai-video-pipeline/hermes-nous/bridge/publer-draft.ts --dry-run
node sffs-ai-video-pipeline/hermes-nous/bridge/donottouch.ts snapshot --dry-run
```

The authoritative plan + next step live in the ralph state files at
`/Users/khoilam/hermes-nous-build/.ralph/` (`state.md`, `guardrails.md`, `progress.md`, `failures.md`)
and `RALPH_TASK.md`.
