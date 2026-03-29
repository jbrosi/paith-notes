#!/usr/bin/env sh
# Upgrade PHP dependencies to their latest allowed versions.
# Default: runs locally (requires php/composer on PATH).
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
    worker composer update --working-dir=/app/api --no-interaction
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    worker composer update --working-dir=/app/worker --no-interaction
else
  composer update --working-dir="$ROOT_DIR/app/api" --no-interaction
  composer update --working-dir="$ROOT_DIR/app/worker" --no-interaction
fi
