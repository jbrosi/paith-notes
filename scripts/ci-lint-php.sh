#!/usr/bin/env sh
# Run PHP linting (phpcs + phpstan) via Docker — used in CI.
# For local use inside the claude container, run scripts/lint.sh instead.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

mkdir -p "$ROOT_DIR/.ci-cache/composer"

PROJECT=${PROJECT:-notes-ci-php}

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    -v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
    -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
    worker composer phpcs --working-dir=/app/worker

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    -v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
    -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
    worker composer phpstan --working-dir=/app/worker
