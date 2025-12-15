#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps worker composer install --working-dir=/app/api --no-interaction
docker compose run --rm --no-deps worker composer install --working-dir=/app/worker --no-interaction
