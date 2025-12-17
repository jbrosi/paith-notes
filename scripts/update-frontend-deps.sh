#!/usr/bin/env sh
set -eu

docker compose run --rm --no-deps frontend sh -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && yarn upgrade --non-interactive"
