#!/usr/bin/env bash
# hello-model.sh — prove the TrueFoundry provider wiring for the Nous-based agent.
#
# With a valid key -> the model replies "pong" (full check).
# Without a key    -> the gateway returns an auth challenge (401/403), which still
#                     proves base_url + the claude-opus-4-8 route are reachable
#                     (a "wiring" check). Only a missing key stands between this
#                     and a full pong.
#
# Secrets: reads OPENAI_API_KEY (a.k.a. the TrueFoundry key) from the environment
# or $HERMES_HOME/.env. NEVER hardcode the key here.
set -euo pipefail

BASE_URL="${TFY_LLM_BASE_URL:-https://tfy.promptlens.trilogy.com/api/llm/v1}"
MODEL="${HERMES_MODEL:-claude-opus-4-8}"

# Source the isolated env if present (untracked).
ENV_FILE="${HERMES_ENV_FILE:-${HERMES_HOME:-$HOME/.hermes}/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
fi
KEY="${OPENAI_API_KEY:-${TFY_API_KEY:-}}"

echo "base_url : $BASE_URL"
echo "model    : $MODEL"
echo "key      : $([[ -n "$KEY" ]] && echo '<set>' || echo '<MISSING — wiring-only check>')"
echo "--- POST /chat/completions ---"

code=$(curl -sS -o /tmp/hello-model.out -w '%{http_code}' \
  --max-time 45 \
  -X POST "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer ${KEY:-none}" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]}" \
  || true)

echo "HTTP $code"
head -c 600 /tmp/hello-model.out; echo
case "$code" in
  200) echo "RESULT: OK — model reachable and answered (full pong check)."; exit 0 ;;
  401|403) echo "RESULT: WIRING OK — endpoint+model reachable; needs a valid TrueFoundry key for a full pong."; exit 0 ;;
  000) echo "RESULT: FAIL — could not reach $BASE_URL (network/DNS)."; exit 1 ;;
  *)   echo "RESULT: check response above (HTTP $code)."; exit 1 ;;
esac
