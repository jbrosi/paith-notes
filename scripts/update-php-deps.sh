#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

PROJECT="notes-tools"

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps worker composer update --working-dir=/app/api --no-interaction
docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps worker composer update --working-dir=/app/worker --no-interaction
