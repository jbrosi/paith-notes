#!/usr/bin/env sh
# Auto-fix lint issues directly (inside the claude container).
set -eu

echo "==> PHP: phpcbf"
# phpcbf exits 1 when it makes fixes (not an error), so we ignore the exit code.
/app/worker/vendor/bin/phpcbf --standard=/app/phpcs.xml || true

echo "==> Frontend: biome check --write"
cd /app/frontend
yarn biome check --write ./src

echo ""
echo "Done. Run scripts/lint.sh to verify."
