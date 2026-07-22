# hermes-nous dashboard — READ-ONLY supervisor UI

A small, dependency-free web dashboard for the rebuilt `hermes-nous` DRAFT-ONLY
agent. It is a **standalone Node server** (Node built-ins only, no `npm install`),
mirroring the data model + neobrutalist style of the current live dashboard
(`hermes/src/dashboard.ts`) and adding the software-factory **CODE-PR view** and a
**kill-switch indicator**.

> **Strictly read-only + display-only.** It never posts, schedules, publishes,
> merges, or mutates anything, and it introduces **no** publish/schedule/merge
> path. Going live (posting) and merging code are human actions. The read-only
> invariant is asserted at boot (`assertReadOnly`), the `gh` wrapper refuses any
> non-read subcommand, and a test locks that the page renders no mutating control.

## What it shows

- **Cycle status** — last run + next scheduled run (from the systemd/cron timer if
  queryable, else estimated from cadence), videos drafted this cycle, and for each
  video its **A/B dimension/arm** + **quality-gate results** (dedup / questions /
  copy / render, with pass/reject reasons).
- **A/B results** — per-post analytics from `ab-testing/ab-database.json`, plus
  variant-family rollups and current **front-runners** from `ab-testing/learnings.json`.
- **CODE-PR view** — the software factory's **open + merged PRs** (`gh`), each joined
  to the real **CI/E2E test status** (GitHub check rollup) and to the two-key
  auto-merge gate's own record for that branch: the **review-agent verdict**
  (KEY 2), the **harness verdict** (KEY 1), and the final **MERGE/REFUSE** decision
  — read from the gate ledger (`scripts/gate/logs/auto_merge.log`). Gate attempts
  with no matching PR are surfaced too, so nothing is hidden.
- **Loop health + kill-switch** — LLM gateway reachability (best-effort, no token
  spend), disk, and the **factory kill-switch** state (engaged/clear).

## How it reads data (all best-effort; a missing file never crashes the page)

| Surface | Source (default) | Override env |
| --- | --- | --- |
| runs / cycle | `$HERMES_DATA_DIR/runs/<run_id>.json` (+ `.log`) | `HERMES_DATA_DIR`, `HERMES_RUNS_DIR` |
| A/B posts | `ab-testing/ab-database.json` | `HERMES_AB_DB` |
| learnings / rollups | `ab-testing/learnings.json` | `HERMES_LEARNINGS` |
| bank freshness | `content/master-question-bank.json` + usage ledgers | `HERMES_BANK`, `HERMES_USAGE`, `HERMES_USED` |
| PRs | `gh pr list` (open + merged) on the repo's origin | `SFFS_GH_REPO`, `SFFS_DASH_PR_LIMIT` |
| review-agent + test verdict | gate ledger `scripts/gate/logs/auto_merge.log` | `SFFS_GATE_LOG` |
| kill-switch | env `SFFS_FACTORY_KILL` / `HERMES_SFFS_FACTORY_KILL`, or a stop-file | `SFFS_KILL_FILE` |
| next run | `systemctl show <timer>` if present, else est. from cadence | `HERMES_TIMER_UNIT`, `HERMES_CADENCE_HOURS` |

Paths default to the **same locations the live loop uses** (see `hermes/src/config.ts`),
so the dashboard reads exactly the data the agent produces — whether written by the
legacy loop or the rebuilt hermes-nous cycle (same `RunState` shape).

## Auth

HTTP **Basic Auth** (timing-safe), exactly like the current dashboard. Set
`HERMES_DASH_USER` / `HERMES_DASH_PASS`. If no password is configured the server
relies on the network/security-group restriction (parity with `hermes/src/dashboard.ts`).
`/healthz` is the only unauthenticated route (a liveness probe that leaks nothing).

## Run

```bash
# from the repo root (Node 22.6+ / 24+; runs .ts directly, no build step)
HERMES_DASH_PASS=choose-a-strong-pass node hermes-nous/dashboard/server.ts
# → http://localhost:8081  (default port; set HERMES_NOUS_DASH_PORT to change)

# tests (hermetic: no network, no gh, no real files)
cd hermes-nous/dashboard && node --test
```

Port defaults to **8081** so it can run alongside the live dashboard (8080) during
cutover.

## Deploy

`deploy/hermes-nous-dashboard.service` is a systemd unit mirroring
`ops/systemd/hermes-dashboard.service` (separate port, read-only hardening). Copy it
to `/etc/systemd/system/` on the VPS, restrict the port to the operator IP at the
security-group layer, and set `HERMES_DASH_PASS`.

## Endpoints

- `GET /` — the dashboard HTML (auto-refresh 60s).
- `GET /api/health` — `{ llm, kill, schedule, disk, prs, now }`.
- `GET /api/state` — run summaries + bank freshness + kill-switch.
- `GET /api/prs` — the full PR view (open + merged PRs correlated to the gate ledger).
- `GET /api/run?id=<run_id>` — one run's full JSON.
- `GET /healthz` — `ok` (unauthenticated liveness).

## Files

- `server.ts` — HTTP server + basic auth + routes (glue only; no data logic).
- `config.ts` — env-driven config + the frozen `READ_ONLY` invariant.
- `types.ts` — the run-state + PR-view data model (mirrors `hermes/src/state.ts`).
- `data.ts` — read-only loaders (runs, A/B, bank, kill-switch, schedule, health).
- `prs.ts` — the CODE-PR view: `gh` read + pure gate-ledger parse + PR correlation.
- `render.ts` — pure HTML (reuses the live dashboard's style) + the guardrail-safe page.
- `test/dashboard.test.ts` — hermetic tests, incl. the display-only guardrail lock.
- `deploy/hermes-nous-dashboard.service` — systemd unit.
