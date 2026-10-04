#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

PROJECT="notes-api-tests-$(date +%s)-$$"

COMPOSE_FILE="docker-compose.api-tests.yml"

cleanup() {
  docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}

trap 'status=$?; cleanup || true; exit $status' EXIT INT TERM

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" up -d db files

# Install dev dependencies if not present (dev targets don't install them in prod stage)
docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm --workdir=/app/api api sh -c "test -d vendor || composer install --no-interaction --no-progress"
docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm --workdir=/app/worker worker sh -c "test -d vendor || composer install --no-interaction --no-progress"

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm api sh -c "DATABASE_URL=\"\$DATABASE_URL\" FILES_DATA_PATH=\"\$FILES_DATA_PATH\" composer test"
docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm worker sh -c "DATABASE_URL=\"\$DATABASE_URL\" FILES_DATA_PATH=\"\$FILES_DATA_PATH\" composer test"
