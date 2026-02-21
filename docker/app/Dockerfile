FROM dunglas/frankenphp:latest AS dev

RUN install-php-extensions pdo_pgsql

COPY --from=composer:latest /usr/bin/composer /usr/local/bin/composer

WORKDIR /app

FROM dev AS prod

COPY Caddyfile /etc/frankenphp/Caddyfile

COPY app/api/composer.json app/api/composer.lock /app/api/
COPY app/backend-shared /app/backend-shared

RUN composer install --working-dir=/app/api --no-dev --no-interaction --no-progress

COPY app/api /app/api
