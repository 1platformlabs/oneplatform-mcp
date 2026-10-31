#!/usr/bin/env bash
# Corre la semilla y la sonda del MCP contra un banco ya levantado.
#   e2e/run-bench.sh <dir-del-banco> <worktree-api> <puerto-api> <puerto-portal> <salida>
# El banco: Mongo propio + API de origin/main + nginx del portal (ver e2e/README.md).
set -euo pipefail
BANK=$1 API=$2 API_PORT=$3 DOCS_PORT=$4 OUT=$5
HERE=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
source "$BANK/env.sh"
mkdir -p "$OUT"
umask 077
API_ROOT=$API "$API/.venv-e2e/bin/python" "$HERE/e2e/seed_bench.py" > "$BANK/fixture.json" 2>/dev/null
BENCH_API=http://127.0.0.1:$API_PORT \
BENCH_DOCS=http://developer.1platform.pro:$DOCS_PORT \
MONGO_CHECK="$API/.venv-e2e/bin/python $HERE/e2e/mongo_check.py" \
  node "$HERE/e2e/probe.mjs" "$BANK/fixture.json" "$OUT"
