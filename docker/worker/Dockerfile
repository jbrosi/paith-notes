FROM php:8.4-cli AS dev

COPY --from=composer:latest /usr/bin/composer /usr/local/bin/composer

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev libcurl4-openssl-dev git unzip ca-certificates autoconf g++ make pkg-config \
    && docker-php-ext-install pdo_pgsql curl \
    && pecl install pcov \
    && docker-php-ext-enable pcov \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM dev AS prod

COPY app/worker/composer.json app/worker/composer.lock /app/worker/
COPY app/backend-shared /app/backend-shared

RUN composer install --working-dir=/app/worker --no-dev --no-interaction --no-progress

COPY app/worker /app/worker
