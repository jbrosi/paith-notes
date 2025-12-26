#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -z "${DISPLAY:-}" ]; then
	echo "DISPLAY is not set. Cannot run Cypress open UI."
	exit 1
fi

XAUTHORITY_PATH=${XAUTHORITY:-"$HOME/.Xauthority"}

if [ ! -d /tmp/.X11-unix ]; then
	echo "/tmp/.X11-unix is missing. Cannot run Cypress open UI."
	exit 1
fi

START_ONLY=1 NO_CLEANUP=1 sh "$ROOT_DIR/scripts/run-frontend-e2e-tests.sh"

mkdir -p "$ROOT_DIR/.ci-cache/yarn" "$ROOT_DIR/.ci-cache/cypress"

docker run --rm \
	--network host \
	-v /tmp/.X11-unix:/tmp/.X11-unix \
	-e DISPLAY="$DISPLAY" \
	-e QT_X11_NO_MITSHM=1 \
	$(if [ -f "$XAUTHORITY_PATH" ]; then printf '%s' "-v $XAUTHORITY_PATH:/tmp/.Xauthority:ro -e XAUTHORITY=/tmp/.Xauthority "; fi)\
	-v "$ROOT_DIR/app/frontend:/app/frontend" \
	-v "$ROOT_DIR/.ci-cache/yarn:/tmp/yarn-cache" \
	-v "$ROOT_DIR/.ci-cache/cypress:/cypress-cache" \
	-e YARN_CACHE_FOLDER=/tmp/yarn-cache \
	-e CYPRESS_CACHE_FOLDER=/cypress-cache \
	-e CYPRESS_baseUrl=http://localhost:8000 \
	-w /app/frontend \
	--shm-size=1g \
	--entrypoint sh \
	docker.io/cypress/included:15.8.1 \
	-lc "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable && yarn install && if [ -z \"$(ls -A /cypress-cache 2>/dev/null || true)\" ]; then cp -a /root/.cache/Cypress/. /cypress-cache/ 2>/dev/null || true; fi && cypress open"
