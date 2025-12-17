#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps worker composer test --working-dir=/app/api
