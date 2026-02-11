#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

mkdir -p "$ROOT_DIR/.ci-cache/composer"

PROJECT=${PROJECT:-notes-ci-php}

docker compose -f docker-compose.yml --project-name "$PROJECT" build worker

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
  -v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  worker composer install --working-dir=/app/worker --no-interaction --prefer-dist

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
  -v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  worker composer install --working-dir=/app/api --no-interaction --prefer-dist
