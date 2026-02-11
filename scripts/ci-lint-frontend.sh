#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

mkdir -p "$ROOT_DIR/.ci-cache/yarn"

PROJECT=${PROJECT:-notes-ci-frontend}

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
  -v "$ROOT_DIR/.ci-cache/yarn:/tmp/yarn-cache" \
  -e YARN_CACHE_FOLDER=/tmp/yarn-cache \
  -e CYPRESS_INSTALL_BINARY=0 \
  frontend sh -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && yarn verify"
