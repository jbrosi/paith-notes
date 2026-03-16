#!/usr/bin/env sh
# Run all tests directly (inside the claude container).
# Requires the db service to be running (it is when using docker compose).
# For CI, see scripts/ci-test-php.sh.
set -eu

echo "==> PHP tests (pest)"
/app/api/vendor/bin/pest /app/api

echo ""
echo "All tests passed."
