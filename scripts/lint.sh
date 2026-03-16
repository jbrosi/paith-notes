#!/usr/bin/env sh
# Run all linting checks directly (inside the claude container).
# For CI, see scripts/ci-lint-php.sh and scripts/ci-lint-frontend.sh.
set -eu

echo "==> PHP: phpcs"
/app/worker/vendor/bin/phpcs --standard=/app/phpcs.xml

echo "==> PHP: phpstan"
/app/worker/vendor/bin/phpstan analyse -c /app/phpstan.neon --memory-limit=512M --no-progress

echo "==> Frontend: biome check + stylelint + tsc"
cd /app/frontend
yarn verify

echo ""
echo "All lint checks passed."
