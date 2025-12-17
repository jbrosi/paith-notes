#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps worker composer phpcbf --working-dir=/app/worker
