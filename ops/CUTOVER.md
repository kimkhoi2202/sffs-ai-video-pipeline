# CUTOVER PLAN — swap the live SFFS loop for the Nous-based `hermes-nous` agent

> **Publer is retired (2026-07-28).** Every mention of Publer below is historical.
> Posting, the live calendar and analytics all run on Metricool now — see
> [`docs/hermes/metricool-migration.md`](../docs/hermes/metricool-migration.md).

> **STATUS: NOT EXECUTED. This is a DOCUMENT, not a script.**
> Nothing here has been run. Cutover is **human-gated**: a human runs these steps,
> in order, on the VPS, after explicitly approving. The overnight build never
> touches the VPS, never sshes, never `systemctl`s, never pushes to `main`.

This plan replaces the **current live loop** (custom TypeScript `hermes/src/cycle.ts`
on a systemd timer, off branch `main`) with the **rebuilt agent** (NousResearch
`hermes-agent` framework + the `sffs` plugin + skills + the `sffs-nightly` cron + the
cost governor + the software factory, off branch `hermes-nous`).

Both are **DRAFT-ONLY**. The cutover changes the *engine*, not the *posting policy*:
the new agent still can only ever create Publer **drafts**, never publish/schedule.

---

## 0. Facts (the two systems)

| | CURRENT (live) | NEW (this build) |
|---|---|---|
| Branch | `main` | `hermes-nous` |
| Engine | `node hermes/src/cycle.ts` | Nous `hermes` + `sffs` plugin (wraps the same `hermes/src/*.ts`) |
| Cadence | systemd `hermes-loop.timer` (`OnCalendar=*-*-* 14:00 UTC`) → `hermes-loop.service` (oneshot) | Nous cron `sffs-nightly` (`every 24h`, **PAUSED**) — resumed at cutover |
| Dashboard | `hermes-dashboard.service` → `node hermes/src/dashboard.ts` (:8080) | `hermes-nous-dashboard.service` → `node hermes-nous/dashboard/server.ts` (:8081) |
| Env file | `/etc/hermes/hermes.env` | same file (add the few new vars below) |
| Repo dir | `/home/ec2-user/sffs-ai-video-pipeline` | same repo, `hermes-nous` branch checked out (or a sibling checkout) |
| Data dir | `/home/ec2-user/hermes-data` | same |
| Instance | VPS `i-02a0f171271dc92c2` (do NOT touch during the build) | resize before enabling the factory (see §2) |

The new agent WRAPS the same proven pipeline modules, so the render/S3/Publer-draft
behavior is byte-for-byte the current loop's; only the orchestration/brain/cron/
factory move to the framework.

---

## 1. Pre-cutover gate (must ALL be true before starting)

- [ ] On `hermes-nous` HEAD: `pytest hermes-nous/tests` GREEN (~623) **and**
      `python hermes-nous/scripts/gate/harness.py` GREEN (KEY 1).
- [ ] `hermes-nous/dashboard` node tests GREEN (`cd hermes-nous/dashboard && node --test`).
- [ ] A live **DRAFT-ONLY** cycle dry-run passed end-to-end (design→gates→render), and
      ideally ONE real `sffs_cycle {dry_run:false, target:1-2}` left a reviewable Publer
      DRAFT (never a live post) — see §6.
- [ ] The operator has the TFY / Publer / ElevenLabs keys and (if not using the instance
      role) AWS creds.
- [ ] A maintenance window is chosen so exactly one loop is active at the 14:00 UTC tick
      (avoid both firing the same day — see §5).
- [ ] Rollback owner + steps understood (§8).

---

## 2. Instance sizing + IAM (do this BEFORE enabling the factory)

The current box (t3.large, 2 vCPU / 8 GB) is **under-powered** for the parallel
software factory + concurrent CPU-bound Remotion (headless-Chromium) renders.

- **Resize** the instance to a big ALLOWED type: **`c6i.4xlarge`–`c6i.8xlarge`**
  (16–32 vCPU). Respect the sandbox SCPs: **NOT GPU**, and **NOT 7th-gen**
  (`c7*/m7*/r7*` are denied) — 6th-gen `c6i`/`m6i` is the sweet spot.
  - Stop instance → change instance type → start. (Or blue/green: stand up a new
    c6i box and move the Elastic IP / DNS.) Blue/green is safer and enables an
    instant rollback (keep the old box until verified).
- **S3 via the instance role (IMDSv2), no keys in env.** Confirm the attached IAM
  role can `s3:PutObject`/`GetObject` on `s3://hermes-sffs-media/*`. The upload tool
  reads `S3_BUCKET` (default `hermes-sffs-media`) + `AWS_REGION` from env and uses the
  instance role — no AWS keys in `hermes.env` at cutover.
- Ensure `ffmpeg`/`ffprobe` on PATH, a headless Chromium for Remotion, and Node ≥ 22
  (the pipeline uses native `.ts` execution).

---

## 3. Deploy the new agent (no traffic yet)

All as `ec2-user` on the VPS. Nothing here starts the loop.

```bash
# 3.1 Get the hermes-nous branch onto the box (fetch only; never merge to main).
cd /home/ec2-user/sffs-ai-video-pipeline
git fetch origin hermes-nous
git checkout hermes-nous            # (or: git worktree add ../hermes-nous origin/hermes-nous)

# 3.2 Isolated Python venv for the Nous framework (py3.11; NOT the system py).
#     Install the framework (from its repo/package) into this venv.
python3.11 -m venv /home/ec2-user/.venv-hermes
source /home/ec2-user/.venv-hermes/bin/activate
pip install -U pip && pip install pytest
# ... install NousResearch/hermes-agent into this venv (editable or pinned) ...

# 3.3 Node deps + render toolchain (wrapped pipeline).
( cd hermes/ && npm install )                 # openai client for the LLM path
( cd remotion/ && npm install && npx remotion browser ensure )   # Remotion + Chromium

# 3.4 Isolated HERMES_HOME (NEVER the real ~/.hermes).
export HERMES_HOME=/home/ec2-user/.hermes-nous
mkdir -p "$HERMES_HOME"
cp hermes-nous/config/config.yaml.example "$HERMES_HOME/config.yaml"
#   EDIT $HERMES_HOME/config.yaml:
#     - skills.external_dirs -> /home/ec2-user/sffs-ai-video-pipeline/hermes-nous/skills
#       (the example pins the BUILD machine's absolute path — repoint it to the VPS path)
#     - delegation.max_concurrent_children: 16 (c6i.4xlarge) — high-but-finite
#     - delegation.subagent_auto_approve: true  (SAFE NOW: the cost governor + kill-switch exist)

# 3.5 Enable the sffs plugin + skills + memory in HERMES_HOME.
bash hermes-nous/scripts/link-plugin.sh       # symlink + `hermes plugins enable sffs`
bash hermes-nous/scripts/link-skills.sh       # skills.external_dirs + install MEMORY.md
hermes tools list | grep sffs                 # expect the 12 sffs tools, toolset enabled
hermes skills list | grep sffs                # sffs-ab-cycle + sffs-software-factory enabled

# 3.6 Register the nightly cron — it self-registers PAUSED (nothing fires yet).
bash hermes-nous/scripts/cron-setup.sh
hermes cron list --all                        # sffs-nightly present, PAUSED
```

---

## 4. Env / keys (`/etc/hermes/hermes.env`, root:hermes 0640 — NEVER in git)

Keep the existing file; the new agent reads the SAME keys. Add/confirm:

| Var | Purpose | Notes |
|---|---|---|
| `OPENAI_API_KEY` | TrueFoundry key for the Nous `custom` provider **and** the pipeline `llm.ts` | Same TFY key. `config.yaml` feeds it via `api_key: "${OPENAI_API_KEY}"`. `TFY_API_KEY` also works (config.ts falls back to `OPENAI_API_KEY`). |
| `PUBLER_API_KEY`, `PUBLER_WORKSPACE_ID` | Publer DRAFT creation + read analytics | Existing. |
| `ELEVENLABS_API_KEY` | Cloned-voice narration (voiced A/B arms) | Existing. |
| `S3_BUCKET`, `AWS_REGION` | S3 media host | Default `hermes-sffs-media` / `us-east-1`; creds via the **instance role** (no keys). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` | FALLBACK media host only | Do **not** migrate media to Supabase; S3 is primary. |
| `HERMES_HOME` | `/home/ec2-user/.hermes-nous` | Isolated; not the real `~/.hermes`. |
| `HERMES_DATA_DIR` | `/home/ec2-user/hermes-data` | Renders/runs land here (outside the repo). |
| **`SFFS_FACTORY_KILL`** | Cost-governor / factory **kill-switch** | Leave **unset** normally; set `=1` to halt the factory + loop instantly. |
| `SFFS_COST_MAX_USD_PER_DAY` etc. | Cost ceilings (optional override) | Defaults: $75/day, 40M tokens/day, 8 children, 500 spawns/day. Raise/lower per policy. |

`git status` before any commit; confirm no secret file is staged. LLM output is DATA,
never executed; code lands only via the two-key gate.

---

## 5. The systemd swap (atomic-ish; exactly one loop active)

**Stop + disable the OLD loop first, then enable the NEW one.** Never leave both timers
enabled (two cycles → double drafts + double spend).

```bash
# 5.1 STOP the current loop (leave its unit files in place for rollback).
sudo systemctl disable --now hermes-loop.timer      # stop the 14:00 UTC trigger
sudo systemctl stop hermes-loop.service             # (oneshot; ensure not mid-run)
sudo systemctl disable --now hermes-dashboard.service  # free :8080 (optional; can coexist on :8081)
```

Choose the new cadence — **A (recommended)** or **B (parity)**:

### 5A. Recommended: the framework-native cron scheduler as a service
Run the Nous scheduler continuously; it fires `sffs-nightly` every 24h. Create
`/etc/systemd/system/hermes-nous-agent.service`:

```ini
[Unit]
Description=Hermes-Nous SFFS agent — cron scheduler (DRAFT-ONLY cycle + software factory)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/sffs-ai-video-pipeline
Environment=HERMES_HOME=/home/ec2-user/.hermes-nous
EnvironmentFile=/etc/hermes/hermes.env
# Long-running scheduler; runs sffs-nightly on its 24h cadence.
ExecStart=/home/ec2-user/.venv-hermes/bin/hermes cron scheduler
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-nous-agent.service   # scheduler up; job still PAUSED
```
(Confirm the exact scheduler subcommand with `hermes cron --help` on the box; if the
framework has no long-running scheduler subcommand, use path **5B**.)

### 5B. Parity alternative: keep the systemd timer, invoke one cycle
Mirror the current 14:00 UTC timer, but run the new agent's cycle once per fire.
`/etc/systemd/system/hermes-nous-loop.service`:

```ini
[Unit]
Description=Hermes-Nous SFFS DRAFT-ONLY cycle (Nous agent; one run)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory=/home/ec2-user/sffs-ai-video-pipeline
Environment=HERMES_HOME=/home/ec2-user/.hermes-nous
EnvironmentFile=/etc/hermes/hermes.env
# Trigger one DRAFT-ONLY cycle via the registered cron job (follows sffs-ab-cycle).
ExecStart=/home/ec2-user/.venv-hermes/bin/hermes cron run sffs-nightly
TimeoutStartSec=5400
Nice=10

[Install]
WantedBy=multi-user.target
```
`/etc/systemd/system/hermes-nous-loop.timer`:
```ini
[Unit]
Description=Trigger the Hermes-Nous DRAFT-ONLY cycle ~daily (Publer analytics lag)
[Timer]
OnCalendar=*-*-* 14:00:00 UTC
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-nous-loop.timer      # 24h trigger armed
```

### 5.3 New dashboard (read-only supervisor, :8081)
```bash
sudo cp hermes-nous/dashboard/deploy/hermes-nous-dashboard.service /etc/systemd/system/
# set HERMES_HOME + HERMES_DASH_PASS in the env; restrict :8081 to the operator IP at the SG.
sudo systemctl daemon-reload && sudo systemctl enable --now hermes-nous-dashboard
```

---

## 6. Verify (before go-live) — on the box, still gated

- [ ] `source /home/ec2-user/.venv-hermes/bin/activate && export HERMES_HOME=/home/ec2-user/.hermes-nous`
- [ ] `python hermes-nous/scripts/gate/harness.py` → **GREEN** (KEY 1 on the box).
- [ ] `sffs_cycle {preview:true}` → resolved config sane; `HERMES_SKIP_GIT` not forced on the VPS
      (the box is allowed to `git push HEAD:main` for the pipeline's own commit path — the SANDBOX
      forces skip, prod does not).
- [ ] ONE real DRAFT-ONLY cycle bounded small: `sffs_cycle {dry_run:false, target:1}` →
      renders, uploads to S3, creates **1 Publer DRAFT**, `sffs_donottouch_verify` OK
      (no pre-existing post changed). Review the draft in Publer — it must be a DRAFT.
- [ ] Dashboard at `https://<host>:8081` shows the run + kill-switch **clear**.
- [ ] **Kill-switch test:** `touch /home/ec2-user/hermes-data/FACTORY_STOP` (or export
      `SFFS_FACTORY_KILL=1`) → confirm `delegate_task`/`sffs_cycle`/`sffs_factory` are refused
      and the dashboard shows the kill engaged; then remove the file / unset the env to re-arm.
- [ ] **Factory dry-run on the box:** `sffs_factory {source:"<a test branch>", dry_run:true}` →
      two-key decision computed, **no merge**.

---

## 7. Go-live

- [ ] `hermes cron resume sffs-nightly` (path 5A), or confirm `hermes-nous-loop.timer` is enabled
      (path 5B). This is the single action that makes the new loop autonomous.
- [ ] Watch the first scheduled run on the dashboard; confirm drafts appear and do-not-touch
      verifies.
- [ ] (Optional, later) enable the software factory's real auto-merge on `hermes-nous` — it
      is gated by the two-key gate + cost governor + kill-switch and NEVER targets `main`.

---

## 8. Rollback (fast, tested path)

Symptom → action:

1. **Immediate halt (any doubt):** `touch /home/ec2-user/hermes-data/FACTORY_STOP` **and**
   `export SFFS_FACTORY_KILL=1` (systemd: add to the env file + restart) → the factory + loop
   stop starting new work at once. `hermes cron pause sffs-nightly`.
2. **Revert to the old loop:**
   ```bash
   sudo systemctl disable --now hermes-nous-agent.service hermes-nous-loop.timer hermes-nous-dashboard
   sudo systemctl enable --now hermes-loop.timer hermes-dashboard.service   # old loop back
   ```
   (Blue/green: just move the Elastic IP / DNS back to the old box and terminate the new one.)
3. **Bad auto-merged code:** the factory records a rollback point (previous target SHA) per
   merge; reset `hermes-nous` to it (`git update-ref` / `git revert`) and re-run the harness.
   The live loop on `main` is unaffected regardless (the factory never targets `main`).
4. **Verify the old loop drafts** on its next tick; confirm do-not-touch intact.

No data migration is needed to roll back: both engines read/write the SAME `ab-testing/*.json`
+ `hermes-data/` + Publer workspace, so reverting the engine loses nothing.

---

## 9. Guardrails that remain TRUE after cutover

- **DRAFT-ONLY forever.** The new agent (like the old) can only create Publer drafts —
  belt (`draft_guard`) + suspenders (`createDraftOnly`) + framework hook (`publish_guard`).
  Publishing/scheduling stays a human action. Code autonomy ≠ posting autonomy.
- **Software-factory auto-merge is TWO-KEY + scoped + reversible + kill-switched**, and
  NEVER targets `main`/prod. Prod deploy is this human-gated cutover, not the factory.
- **Cost is aggressive-but-bounded:** high daily ceilings + hard stop + kill-switch on the
  shared sandbox.
- **Secrets stay out of git** (`/etc/hermes/hermes.env` only).
```
