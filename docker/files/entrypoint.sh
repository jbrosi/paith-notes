#!/bin/sh
# Validate runtime config, prepare the data volume, then exec nginx.
set -eu

if [ -z "${FILES_SIGNING_KEY:-}" ]; then
    echo "[paith files] FATAL: FILES_SIGNING_KEY is required but not set." >&2
    echo "[paith files]   Generate with: openssl rand -hex 32" >&2
    exit 1
fi

case "${FILES_SIGNING_KEY}" in
    *replace-me*|*change-me*|*paste-here*)
        echo "[paith files] WARNING: FILES_SIGNING_KEY matches a placeholder string from .env.example." >&2
        echo "[paith files]   Replace with: openssl rand -hex 32" >&2
        ;;
esac

if [ "${#FILES_SIGNING_KEY}" -lt 32 ]; then
    echo "[paith files] WARNING: FILES_SIGNING_KEY is shorter than 32 characters." >&2
fi

mkdir -p /data/tmp /data/notes
chown -R nginx:nginx /data

exec "$@"
