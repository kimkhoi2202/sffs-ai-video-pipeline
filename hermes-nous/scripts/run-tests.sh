#!/usr/bin/env bash
# run-tests.sh — run the hermes-nous Python test suite in the ISOLATED venv.
# This is the (growing) suite that gates the software-factory auto-merge:
# a non-zero exit here MUST block any merge.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/Users/khoilam/hermes-nous-build}"
REPO="$WORKSPACE/sffs-ai-video-pipeline"
VENV="$WORKSPACE/.venv-hermes"

# shellcheck disable=SC1091
source "$VENV/bin/activate"

# Ensure pytest is available in the isolated venv (dev-only; not committed).
# NOTE: uv-created venvs ship WITHOUT pip (failure F5), so prefer `uv pip`.
python -c "import pytest" 2>/dev/null \
  || uv pip install -q pytest 2>/dev/null \
  || pip install -q pytest

cd "$REPO"
exec python -m pytest hermes-nous/tests -v "$@"
