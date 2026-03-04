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
docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm worker composer test --working-dir=/app/api
