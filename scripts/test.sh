#!/usr/bin/env sh
# Run all tests.
# Default: runs locally (requires php/composer and a running PostgreSQL configured via env vars).
# Pass --docker to run via Docker Compose instead (starts its own database).
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --docker) DOCKER=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ "$DOCKER" = "1" ]; then
  sh "$ROOT_DIR/scripts/run-api-tests.sh"
else
  echo "==> PHP tests (pest)"
  app/api/vendor/bin/pest app/api
  echo ""
  echo "All tests passed."
fi
