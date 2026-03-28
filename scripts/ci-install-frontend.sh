#!/usr/bin/env sh
# Install frontend dependencies for CI (no Docker required — run after setup-node in CI).
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

mkdir -p "$ROOT_DIR/.ci-cache/yarn"
export YARN_CACHE_FOLDER="$ROOT_DIR/.ci-cache/yarn"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

cd "$ROOT_DIR/app/frontend"
corepack enable
yarn install
