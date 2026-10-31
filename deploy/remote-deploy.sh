#!/bin/bash
# Forced command of the MCP deploy key on the dedicated host (installed as
# /usr/local/bin/oneplatform-mcp-deploy; the key is `restrict,command=...`).
# The ONLY thing that key can do:
#
#   <qa|prod> <40-hex sha on origin/main>   build and start that commit
#   <qa|prod> rollback                       go back to the previous image
#
# The repository is public, so the host clones it without a token. A commit
# that is not on main is refused. The previous image is kept as
# oneplatform-mcp:<env>-previous; a deploy whose /healthz does not answer
# rolls back to it by itself and exits non-zero.
set -euo pipefail

ARGS="${SSH_ORIGINAL_COMMAND:-$*}"
read -r ENV TARGET EXTRA <<<"$ARGS" || true
fail() { echo "::error::$*" >&2; exit 1; }
[[ "${ENV:-}" =~ ^(qa|prod)$ ]] || fail "env must be qa or prod"
[[ -z "${EXTRA:-}" ]] || fail "unexpected arguments"
case "$ENV" in prod) PORT=3047 ;; qa) PORT=3048 ;; esac

DIR=/home/apps/oneplatform-mcp
REPO=https://github.com/1platformlabs/oneplatform-mcp.git
IMAGE="oneplatform-mcp:$ENV"
COMPOSE=(docker compose -f "$DIR/deploy/compose.$ENV.yml")

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" | grep -q "\"env\":\"$ENV\""; then return 0; fi
    sleep 2
  done
  return 1
}

if [[ "${TARGET:-}" == rollback ]]; then
  docker image inspect "$IMAGE-previous" >/dev/null 2>&1 || fail "no previous image for $ENV"
  docker tag "$IMAGE-previous" "$IMAGE"
  "${COMPOSE[@]}" up -d --no-build --force-recreate
  healthy || fail "rollback of $ENV is not healthy"
  echo "rolled back $ENV to $(docker image inspect "$IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  exit 0
fi

[[ "${TARGET:-}" =~ ^[0-9a-f]{40}$ ]] || fail "target must be a full commit sha or 'rollback'"
[[ -d "$DIR/.git" ]] || git clone --quiet "$REPO" "$DIR"
cd "$DIR"
git remote set-url origin "$REPO"
git fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
git cat-file -e "$TARGET^{commit}" 2>/dev/null || fail "$TARGET was not fetched"
git merge-base --is-ancestor "$TARGET" origin/main || fail "$TARGET is not on main"
git checkout --quiet --force --detach "$TARGET"

HAD_PREVIOUS=0
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$IMAGE-previous"
  HAD_PREVIOUS=1
fi
BUILDKIT_PROGRESS=plain "${COMPOSE[@]}" build --pull --build-arg REVISION="$TARGET"
"${COMPOSE[@]}" up -d --force-recreate
if healthy; then
  echo "deployed $ENV $TARGET"
  exit 0
fi
"${COMPOSE[@]}" logs --tail 50 >&2 || true
if [[ $HAD_PREVIOUS == 1 ]]; then
  docker tag "$IMAGE-previous" "$IMAGE"
  "${COMPOSE[@]}" up -d --no-build --force-recreate
  healthy && fail "$TARGET was not healthy; rolled back to the previous image" || fail "$TARGET was not healthy and the rollback is not healthy either"
fi
fail "$TARGET was not healthy (first deploy, nothing to roll back to)"
