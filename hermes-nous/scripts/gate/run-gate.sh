#!/usr/bin/env bash
# run-gate.sh — convenience wrapper for the SFFS two-key auto-merge gate.
#
# Runs inside the ISOLATED venv (same one that gates the plugin tests) so the
# harness's pytest leg uses the right interpreter. Subcommands:
#
#   harness                 run the E2E harness -> GREEN/RED           (key #1)
#   selfcheck               run the plugin + DRAFT-ONLY guard check
#   review   <diff-args...>  run the review agent -> APPROVE/REJECT     (key #2)
#   merge    <gate-args...>  run the two-key auto-merge gate (dry-run by default)
#   test                    run the gate's own e2e suite (tests/e2e)
#
# Examples:
#   bash run-gate.sh harness --json
#   bash run-gate.sh review --from hermes-nous --to my-feature
#   bash run-gate.sh merge --source my-feature --target hermes-nous            # dry-run
#   bash run-gate.sh merge --source my-feature --target hermes-nous --execute  # real merge
set -euo pipefail

WORKSPACE="${WORKSPACE:-/Users/khoilam/hermes-nous-build}"
VENV="${VENV:-$WORKSPACE/.venv-hermes}"
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_NOUS_DIR="$(cd "$GATE_DIR/../.." && pwd)"

# shellcheck disable=SC1091
[[ -f "$VENV/bin/activate" ]] && source "$VENV/bin/activate"

cmd="${1:-harness}"; shift || true
case "$cmd" in
  harness)   exec python "$GATE_DIR/harness.py" "$@" ;;
  selfcheck) exec python "$GATE_DIR/sffs_selfcheck.py" "$@" ;;
  review)    exec python "$GATE_DIR/review_agent.py" "$@" ;;
  merge)     exec python "$GATE_DIR/auto_merge.py" "$@" ;;
  test)      exec python -m pytest "$HERMES_NOUS_DIR/tests/e2e" -v "$@" ;;
  *) echo "usage: run-gate.sh {harness|selfcheck|review|merge|test} [args...]" >&2; exit 2 ;;
esac
