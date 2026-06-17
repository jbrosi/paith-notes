FROM docker.io/nginx:1.29-alpine

# njs ships the QuickJS engine (njs ≥ 0.8.5). nginx.conf opts into it with
# `js_engine qjs;`.
RUN apk add --no-cache nginx-module-njs

COPY entrypoint.sh /paith-entrypoint.sh
COPY nginx.conf    /etc/nginx/nginx.conf
COPY njs           /etc/nginx/njs

RUN chmod +x /paith-entrypoint.sh

# Hard-fails on missing FILES_SIGNING_KEY before nginx starts.
ENTRYPOINT ["/paith-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
