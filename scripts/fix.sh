#!/usr/bin/env sh
# Auto-fix lint issues.
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
  PROJECT=${PROJECT:-notes-fix}

  echo "==> PHP: phpcbf (docker)"
  # phpcbf exits 1 when it makes fixes (not an error), so we ignore the exit code.
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    worker sh -c "composer phpcbf --working-dir=/app/worker || true"

  echo "==> Frontend: biome check --write (docker)"
  docker compose -f docker-compose.yml --project-name "$PROJECT" run --rm --no-deps \
    -e CYPRESS_INSTALL_BINARY=0 \
    frontend sh -lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn biome check --write ./src"
else
  echo "==> PHP: phpcbf"
  # phpcbf exits 1 when it makes fixes (not an error), so we ignore the exit code.
  app/worker/vendor/bin/phpcbf --standard=app/phpcs.xml || true

  echo "==> Frontend: biome check --write"
  cd app/frontend
  yarn biome check --write ./src
fi

echo ""
echo "Done. Run scripts/lint.sh to verify."
