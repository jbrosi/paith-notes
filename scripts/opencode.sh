#!/usr/bin/env sh
# Launch the opencode container as your host user.
set -eu

export UID=$(id -u)
export GID=$(id -g)

docker compose run --rm opencode-dev "$@"
