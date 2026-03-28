#!/usr/bin/env sh
# Run PHP linting (phpcs + phpstan) without Docker — used in CI after setup-php.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR/app"

worker/vendor/bin/phpcs --standard=phpcs.xml
worker/vendor/bin/phpstan analyse -c phpstan.neon --memory-limit=512M --no-progress
