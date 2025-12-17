#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps worker composer phpstan --working-dir=/app/worker
