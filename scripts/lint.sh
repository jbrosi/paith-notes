#!/usr/bin/env sh
# Run all linting checks.
# Default: runs locally (requires php/composer and node/yarn on PATH).
# Pass --docker to run via Docker Compose instead.
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
  PROJECT=${PROJECT:-notes-lint}

  echo "==> PHP: phpcs (docker)"
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    worker composer phpcs --working-dir=/app/worker

  echo "==> PHP: phpstan (docker)"
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    worker composer phpstan --working-dir=/app/worker

  echo "==> Frontend: biome check + stylelint + tsc (docker)"
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    -e CYPRESS_INSTALL_BINARY=0 \
    frontend sh -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn verify"
else
  echo "==> PHP: phpcs"
  app/worker/vendor/bin/phpcs --standard=app/phpcs.xml

  echo "==> PHP: phpstan"
  app/worker/vendor/bin/phpstan analyse -c app/phpstan.neon --memory-limit=512M --no-progress

  echo "==> Frontend: biome check + stylelint + tsc"
  cd app/frontend
  yarn verify
fi

echo ""
echo "All lint checks passed."
