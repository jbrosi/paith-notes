#!/usr/bin/env sh
# Run PHP tests (pest) without Docker — used in CI after setup-php with a postgres service.
# Requires DATABASE_URL env var pointing to a running PostgreSQL instance.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export COMPOSER_CACHE_DIR="$ROOT_DIR/.ci-cache/composer"

mkdir -p "$ROOT_DIR/.ci-cache/composer" "$ROOT_DIR/.ci-cache/files-data/tmp" "$ROOT_DIR/.ci-cache/files-data/notes"
export FILES_DATA_PATH="$ROOT_DIR/.ci-cache/files-data"

echo "==> API tests"
cd "$ROOT_DIR/app/api"
mkdir -p coverage
php -d pcov.enabled=1 vendor/bin/pest --coverage --coverage-clover=coverage/clover.xml

echo "==> Worker tests"
cd "$ROOT_DIR/app/worker"
mkdir -p coverage
php -d pcov.enabled=1 vendor/bin/pest --coverage --coverage-clover=coverage/clover.xml
