#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps worker composer phpcs --working-dir=/app/worker
