FROM dunglas/frankenphp:latest AS dev

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git unzip ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN install-php-extensions pdo_pgsql

COPY --from=composer:latest /usr/bin/composer /usr/local/bin/composer

WORKDIR /app

FROM docker.io/node:24 AS frontend-build

WORKDIR /src/app/frontend

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY app/frontend/package.json app/frontend/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY app/frontend ./
RUN yarn build

FROM dev AS prod

COPY Caddyfile.prod /etc/frankenphp/Caddyfile

COPY app/api/composer.json app/api/composer.lock /app/api/
COPY app/backend-shared /app/backend-shared

RUN composer install --working-dir=/app/api --no-dev --no-interaction --no-progress

COPY app/api /app/api

COPY --from=frontend-build /src/app/frontend/dist /srv/frontend
