#!/usr/bin/env sh
# Install PHP dependencies for CI (no Docker required — run after setup-php in CI).
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

mkdir -p "$ROOT_DIR/.ci-cache/composer"
export COMPOSER_CACHE_DIR="$ROOT_DIR/.ci-cache/composer"

composer install --working-dir="$ROOT_DIR/app/worker" --no-interaction --prefer-dist
composer install --working-dir="$ROOT_DIR/app/api" --no-interaction --prefer-dist
