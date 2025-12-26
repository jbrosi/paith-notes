#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

mkdir -p "$ROOT_DIR/.ci-cache/yarn" "$ROOT_DIR/.ci-cache/cypress"

docker run --rm \
  -v "$ROOT_DIR/app/frontend:/app/frontend" \
  -v "$ROOT_DIR/.ci-cache/yarn:/tmp/yarn-cache" \
  -v "$ROOT_DIR/.ci-cache/cypress:/cypress-cache" \
  -e YARN_CACHE_FOLDER=/tmp/yarn-cache \
  -e CYPRESS_CACHE_FOLDER=/cypress-cache \
  -w /app/frontend \
  --entrypoint sh \
  docker.io/cypress/included:15.8.1 \
  -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && if [ -z \"$(ls -A /cypress-cache 2>/dev/null || true)\" ]; then cp -a /root/.cache/Cypress/. /cypress-cache/ 2>/dev/null || true; fi && yarn test:component"
