#!/usr/bin/env sh
# Upgrade frontend dependencies to their latest allowed versions.
# Default: runs locally (requires node/yarn on PATH).
# Pass --docker to run via Docker Compose instead.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --docker) DOCKER=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ "$DOCKER" = "1" ]; then
  PROJECT="notes-tools"
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    frontend sh -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && yarn upgrade --non-interactive"
else
  cd app/frontend
  yarn install
  yarn upgrade --non-interactive
fi
