#!/usr/bin/env bash
# link-plugin.sh — wire the `sffs` plugin into the ISOLATED HERMES_HOME and
# enable it. Idempotent; safe to re-run. Touches only $HERMES_HOME (untracked),
# never the pipeline repo and never the real ~/.hermes.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/Users/khoilam/hermes-nous-build}"
export HERMES_HOME="${HERMES_HOME:-$WORKSPACE/.hermes-home}"
REPO="$WORKSPACE/sffs-ai-video-pipeline"
SRC="$REPO/hermes-nous/sffs"
DEST_DIR="$HERMES_HOME/plugins"
DEST="$DEST_DIR/sffs"

if [[ ! -d "$SRC" ]]; then
  echo "FATAL: plugin source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
ln -sfn "$SRC" "$DEST"
echo "linked: $DEST -> $(readlink "$DEST")"

# Enable the plugin (user plugins are opt-in via plugins.enabled in config.yaml).
if command -v hermes >/dev/null 2>&1; then
  hermes plugins enable sffs --no-allow-tool-override 2>/dev/null \
    || hermes plugins enable sffs 2>/dev/null \
    || echo "note: could not auto-enable via CLI; ensure config.yaml has plugins.enabled: [sffs]"
else
  echo "note: 'hermes' not on PATH — activate the venv, then: hermes plugins enable sffs"
fi

echo "done. Verify with: hermes plugins list --plain | rg sffs"
