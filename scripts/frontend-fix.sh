#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps frontend sh -lc "corepack enable && yarn install && yarn run check"
