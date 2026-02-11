#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

PROJECT="notes-tools"

docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps worker composer phpcbf --working-dir=/app/worker
