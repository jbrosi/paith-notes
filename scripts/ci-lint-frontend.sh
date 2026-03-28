#!/usr/bin/env sh
# Run frontend linting (biome + stylelint + tsc) without Docker — used in CI after setup-node.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR/app/frontend"

yarn verify
