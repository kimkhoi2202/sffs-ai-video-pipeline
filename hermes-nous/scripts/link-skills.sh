#!/usr/bin/env bash
# link-skills.sh — wire the SFFS skills + framework memory into the ISOLATED
# HERMES_HOME so the agent (and the sffs-nightly cron) can load them:
#
#   1. point config.yaml `skills.external_dirs` at hermes-nous/skills/ (so the
#      `sffs-ab-cycle` playbook is discoverable), idempotently.
#   2. install the curated MEMORY.md into $HERMES_HOME/memories/ (only if absent —
#      never clobber an evolved memory).
#
# Safe + idempotent: re-running does not duplicate the external dir or overwrite
# an existing MEMORY.md.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/Users/khoilam/hermes-nous-build}"
REPO="$WORKSPACE/sffs-ai-video-pipeline"
VENV="$WORKSPACE/.venv-hermes"
export HERMES_HOME="${HERMES_HOME:-$WORKSPACE/.hermes-home}"

# shellcheck disable=SC1091
source "$VENV/bin/activate"

SKILLS_DIR="$REPO/hermes-nous/skills"
MEMORY_SRC="$REPO/hermes-nous/memory/MEMORY.md"

python - "$SKILLS_DIR" "$MEMORY_SRC" <<'PY'
import os, sys
from pathlib import Path

skills_dir, memory_src = sys.argv[1], sys.argv[2]
home = Path(os.environ["HERMES_HOME"]).resolve()

# --- 1. skills.external_dirs -------------------------------------------------
cfg_path = home / "config.yaml"
try:
    import yaml
    cfg = yaml.safe_load(cfg_path.read_text()) or {}
    skills_cfg = cfg.get("skills")
    if not isinstance(skills_cfg, dict):
        skills_cfg = {}
    dirs = skills_cfg.get("external_dirs") or []
    if isinstance(dirs, str):
        dirs = [dirs]
    if skills_dir not in dirs:
        dirs.append(skills_dir)
    skills_cfg["external_dirs"] = dirs
    cfg["skills"] = skills_cfg
    cfg_path.write_text(yaml.safe_dump(cfg, sort_keys=False))
    print(f"skills.external_dirs -> {dirs}")
except Exception as e:
    print(f"WARN: could not update skills.external_dirs automatically ({e}); "
          f"add this to {cfg_path} manually:\n  skills:\n    external_dirs:\n      - {skills_dir}")

# --- 2. install MEMORY.md (only if absent) -----------------------------------
mem_dir = home / "memories"
mem_dir.mkdir(parents=True, exist_ok=True)
mem_dst = mem_dir / "MEMORY.md"
if mem_dst.exists() and mem_dst.read_text().strip():
    print(f"MEMORY.md already present ({mem_dst}) — left untouched")
else:
    mem_dst.write_text(Path(memory_src).read_text())
    print(f"installed MEMORY.md -> {mem_dst}")
PY

echo ""
echo "Skills + memory wired. Verify with: hermes skills list | rg sffs"
