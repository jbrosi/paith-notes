#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

PROJECT="notes-tools"

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps frontend sh -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && yarn upgrade --non-interactive"
