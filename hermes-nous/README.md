# hermes-nous — SFFS agent rebuilt on the Nous Hermes framework

This directory holds the **in-progress** re-base of the SFFS autonomous DRAFT-ONLY A/B video agent
(currently `hermes/`) onto the open-source [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
framework, using that framework's cron learning loop, memory, skills, subagents, and dashboard.

> Status: **iteration 1 (foundation)**. Nothing here is deployed. The live loop in `hermes/` on `main`
> keeps running untouched. This work lives ONLY on the `hermes-nous` branch. Cutover is human-gated.

## Two autonomy domains (do not conflate)
- **CODE = high autonomy (the "software factory").** The deployed agent opens PRs for its own code and
  auto-merges them itself — but ONLY on GREEN CI, scoped to this pipeline + the agent's own code, with a
  rollback path + kill-switch. Parallelized via Nous `delegate_task` subagents.
- **SOCIAL POSTING = draft-only, human-gated, physically enforced.** The agent may only create Publer
  DRAFTS; it can never publish or schedule a live post. Code autonomy does NOT grant posting autonomy.

## Layout
- `config/config.yaml.example` — Hermes config pointing the `custom` provider at TrueFoundry
  (`claude-opus-4-8`). Copy to an ISOLATED `$HERMES_HOME/config.yaml`.
- `config/hermes.env.example` — required secret var names (TrueFoundry, Publer, S3, ElevenLabs, GitHub).
  Real values go in `$HERMES_HOME/.env` only — NEVER in git.
- `scripts/hello-model.sh` — proves the TrueFoundry wiring (200=pong with a key; 401=wiring OK, key
  missing).
- `plugin/`, `skills/`, `tests/` — the `sffs` Hermes plugin (tools that wrap the proven pipeline TS
  modules), skill playbooks, and the E2E/validation suite. (Being built iteration by iteration.)

## Quick start (isolated, local)
```bash
# from the workspace root /Users/khoilam/hermes-nous-build
source .venv-hermes/bin/activate
export HERMES_HOME=/Users/khoilam/hermes-nous-build/.hermes-home
# drop the TrueFoundry key into $HERMES_HOME/.env as OPENAI_API_KEY=... (untracked), then:
bash sffs-ai-video-pipeline/hermes-nous/scripts/hello-model.sh
```

The authoritative plan + next step live in the ralph state files at
`/Users/khoilam/hermes-nous-build/.ralph/` (`state.md`, `guardrails.md`, `progress.md`, `failures.md`)
and `RALPH_TASK.md`.
