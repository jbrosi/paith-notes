#!/usr/bin/env sh
set -eu

docker compose run --rm worker composer test --working-dir=/app/api
