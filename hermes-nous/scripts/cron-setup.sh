#!/usr/bin/env bash
# cron-setup.sh — register (or refresh) the `sffs-nightly` cron job in the ISOLATED
# HERMES_HOME. The job runs ONE full DRAFT-ONLY A/B cycle on a ~24h cadence (aligned
# to Publer's ~24h analytics lag) by following the `sffs-ab-cycle` skill.
#
# SAFETY: the job is created PAUSED (disabled). Nothing fires tonight. A human
# RESUMES it at the human-gated cutover:
#     hermes cron resume sffs-nightly     (or: hermes cron list / run <id>)
# Even when it does run, it is DRAFT-ONLY (creates Publer drafts, never publishes/
# schedules) and can never push to main (the cycle forces HERMES_SKIP_GIT=1).
#
# Idempotent: re-running removes any prior `sffs-nightly` job(s) first.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/Users/khoilam/hermes-nous-build}"
REPO="$WORKSPACE/sffs-ai-video-pipeline"
VENV="$WORKSPACE/.venv-hermes"
export HERMES_HOME="${HERMES_HOME:-$WORKSPACE/.hermes-home}"

# shellcheck disable=SC1091
source "$VENV/bin/activate"

python - "$REPO" <<'PY'
import sys
from cron import jobs as J

repo = sys.argv[1]

# --- idempotent: drop any existing sffs-nightly job(s) ----------------------
existing = [j for j in J.list_jobs(include_disabled=True) if (j.get("name") or "").strip() == "sffs-nightly"]
for j in existing:
    J.remove_job(j["id"])
    print(f"removed existing sffs-nightly job: {j['id']}")

PROMPT = (
    "Run ONE full DRAFT-ONLY SFFS A/B quiz-video cycle for today by following the "
    "sffs-ab-cycle skill. In order: refresh scoring (sffs_score_rollup) so the A/B "
    "memory reflects matured analytics, snapshot do-not-touch, design the batch "
    "(rotating dimensions incl. the narration family + progress-counter arms), run "
    "the fail-closed quality gates, render, upload to S3, and create Publer DRAFTS "
    "(target 10; sffs_cycle with dry_run=false). Then verify do-not-touch and record "
    "a one-line takeaway (drafts made, any new front-runner) in memory. You are "
    "DRAFT-ONLY: never publish or schedule a live post, never touch existing posts, "
    "never push to main. If do-not-touch verification fails, STOP and report."
)

job = J.create_job(
    prompt=PROMPT,
    schedule="every 24h",          # recurring ~24h (Publer metrics lag). NOTE: bare "24h" = one-shot.
    name="sffs-nightly",
    skills=["sffs-ab-cycle"],      # load the cycle playbook
    enabled_toolsets=["sffs"],     # restrict to the sffs toolset (lean, safe)
    workdir=repo,                  # run from the pipeline repo
    no_agent=False,
)
jid = job["id"]
print(f"created sffs-nightly: {jid}  schedule={job.get('schedule')}")

# --- SAFETY: pause it. It is registered but INACTIVE until a human resumes it
#     at the human-gated cutover. Nothing fires tonight.
paused = J.pause_job(jid, reason="human-gated cutover: resume only after cutover approval")
print(f"PAUSED sffs-nightly ({jid}) — resume with `hermes cron resume {jid}` at cutover" if paused else "WARN: pause failed")
PY

echo ""
echo "Registered (paused) sffs-nightly. Inspect with: hermes cron list --all"
