#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

mkdir -p "$ROOT_DIR/.ci-cache/yarn" "$ROOT_DIR/.ci-cache/cypress" "$ROOT_DIR/.ci-cache/composer"

cleanup() {
	if [ "${START_ONLY:-0}" = "1" ]; then
		return 0
	fi

	if [ "${NO_CLEANUP:-0}" = "1" ]; then
		return 0
	fi

	if [ -n "${CI:-}" ]; then
		docker compose down -v
	else
		docker compose down
	fi
}
trap cleanup EXIT

# Build worker image from this monorepo (needed for composer installs)
docker compose build worker

# Ensure API deps are installed (required for /health and app runtime)
docker compose run --rm --no-deps \
	-v "$ROOT_DIR/.ci-cache/composer:/tmp/composer-cache" \
	-e COMPOSER_CACHE_DIR=/tmp/composer-cache \
	worker composer install --working-dir=/app/api --no-interaction --prefer-dist

# Start full stack (app will pull in frontend, db, rustfs)
docker compose up -d db rustfs app

echo "Waiting for services to be ready..."
for i in $(seq 1 60); do
	if curl -f http://localhost:8000/health >/dev/null 2>&1; then
		echo "API is ready!"
		if curl -f http://localhost:8000 >/dev/null 2>&1; then
			echo "Frontend is ready!"
			break
		fi
	fi
	echo "Waiting... (${i}/60)"
	sleep 2
done

if ! curl -f http://localhost:8000/health >/dev/null 2>&1; then
	echo "Services failed to start"
	docker compose logs
	exit 1
fi

if [ "${START_ONLY:-0}" = "1" ]; then
	echo "Stack is running. You can now run Cypress in open mode from your host."
	exit 0
fi

docker run --rm \
	--network host \
	-v "$ROOT_DIR/app/frontend:/app/frontend" \
	-v "$ROOT_DIR/.ci-cache/yarn:/tmp/yarn-cache" \
	-v "$ROOT_DIR/.ci-cache/cypress:/cypress-cache" \
	-e YARN_CACHE_FOLDER=/tmp/yarn-cache \
	-e CYPRESS_CACHE_FOLDER=/cypress-cache \
	-e CYPRESS_baseUrl=http://localhost:8000 \
	-w /app/frontend \
	--entrypoint sh \
	docker.io/cypress/included:15.8.1 \
	-lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && if [ -z \"$(ls -A /cypress-cache 2>/dev/null || true)\" ]; then cp -a /root/.cache/Cypress/. /cypress-cache/ 2>/dev/null || true; fi && yarn test:e2e"
