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

# Render the resolver config from /etc/resolv.conf. The actual DNS IP differs
# by runtime (Docker: 127.0.0.11; podman+netavark: network gateway), and using
# the wrong one breaks every auth_request subrequest with "Connection refused
# while resolving". Pulling from resolv.conf adapts automatically.
# Filter out IPv6 entries — we explicitly set ipv6=off so they'd be ignored,
# and including a `:` address as a positional arg would just confuse nginx.
nameservers=$(awk '/^nameserver/ && $2 !~ /:/{print $2}' /etc/resolv.conf | tr '\n' ' ')
if [ -z "$nameservers" ]; then
    echo "[paith files] FATAL: no IPv4 nameservers in /etc/resolv.conf — auth_request to app:8000 cannot resolve." >&2
    exit 1
fi
cat > /etc/nginx/resolver.conf <<EOF
resolver $nameservers valid=10s ipv6=off;
resolver_timeout 5s;
EOF
echo "[paith files] resolver: $nameservers"

exec "$@"
