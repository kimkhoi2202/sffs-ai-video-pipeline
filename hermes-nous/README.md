# hermes-nous — SFFS agent rebuilt on the Nous Hermes framework

This directory holds the **in-progress** re-base of the SFFS autonomous DRAFT-ONLY A/B video agent
(currently `hermes/`) onto the open-source [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
framework, using that framework's cron learning loop, memory, skills, subagents, and dashboard.

> Status: **iteration 2 (safety core landed)**. Nothing here is deployed. The live loop in `hermes/` on
> `main` keeps running untouched. This work lives ONLY on the `hermes-nous` branch. Cutover is human-gated.

## Two autonomy domains (do not conflate)
- **CODE = high autonomy (the "software factory").** The deployed agent opens PRs for its own code and
  auto-merges them itself — but ONLY on GREEN CI, scoped to this pipeline + the agent's own code, with a
  rollback path + kill-switch. Parallelized via Nous `delegate_task` subagents.
- **SOCIAL POSTING = draft-only, human-gated, physically enforced.** The agent may only create Publer
  DRAFTS; it can never publish or schedule a live post. Code autonomy does NOT grant posting autonomy.

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
- `sffs/` — the `sffs` Hermes **plugin** (`plugin.yaml` + `__init__.py` + `schemas.py` +
  `draft_guard.py`). Iteration 2 registers ONE tool, `sffs_publer_draft`, the DRAFT-ONLY safety core.
- `bridge/publer-draft.ts` — the tiny Node entry the plugin shells into; calls the pipeline's
  `createDraftOnly` path and nothing else (`--dry-run` validates with no network / no keys).
- `tests/test_draft_only.py` — the DRAFT-ONLY assertion suite (41 tests; no network / no node) proving
  the invariant survives the Nous tool layer.
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
bash sffs-ai-video-pipeline/hermes-nous/scripts/run-tests.sh            # 41 passed (gates auto-merge)
bash sffs-ai-video-pipeline/hermes-nous/scripts/link-plugin.sh          # symlink + enable the plugin
hermes tools list | rg sffs                                            # -> ✓ enabled  sffs  🔌 Sffs

# network-free proof the Node bridge only ever creates a draft:
echo '{"account_ids":["a"],"text":"hi"}' | \
  node sffs-ai-video-pipeline/hermes-nous/bridge/publer-draft.ts --dry-run
```

The authoritative plan + next step live in the ralph state files at
`/Users/khoilam/hermes-nous-build/.ralph/` (`state.md`, `guardrails.md`, `progress.md`, `failures.md`)
and `RALPH_TASK.md`.
