#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

mkdir -p "$ROOT_DIR/.ci-cache/composer"

COMPOSE_FILE="docker-compose.api-tests.yml"
PROJECT=${PROJECT:-notes-ci-php-tests}

cleanup() {
  docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap 'status=$?; cleanup || true; exit $status' EXIT INT TERM

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" build worker

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" up -d db rustfs

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm --no-deps \
  -v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  worker composer install --working-dir=/app/worker --no-interaction --prefer-dist

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm --no-deps \
  -v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  worker composer install --working-dir=/app/api --no-interaction --prefer-dist

docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" run --rm worker sh -lc "mkdir -p /app/api/coverage && cd /app/api && php -d pcov.enabled=1 vendor/bin/pest --coverage --coverage-clover=/app/api/coverage/clover.xml"
