# Host deployment template

This folder contains a minimal **pull-only** deployment template.

It assumes:

- You run **nginx (or any reverse proxy) on the host** for TLS.
- The app container listens on `127.0.0.1:8000` (HTTP).
- PostgreSQL is **external** (managed elsewhere).
- Docker images are pulled from **GHCR** (published by GitHub Actions).

## Files

- `docker-compose.yml`
  - Runs `app`, `worker`, and `files`.
  - Binds app to `127.0.0.1:8000`.
- `.env.example`
  - Copy to `.env` on the host and fill in secrets.
- `nginx-site.conf.example`
  - Example host nginx vhost to proxy TLS -> `http://127.0.0.1:8000`.
- `nginx.conf`
  - Nginx config used *inside* the `files` container.

## Setup on the host

1. Copy this folder to your server.
2. Create `.env` from `.env.example`.
3. Set `APP_IMAGE` and `WORKER_IMAGE` to your repo images, e.g.
   - `ghcr.io/<owner>/<repo>/app:latest`
   - `ghcr.io/<owner>/<repo>/worker:latest`
4. If the GHCR packages are private, log in on the server.
5. Start:

```sh
docker compose up -d
```

## External Postgres (recommended)

Set `DATABASE_URL` in `.env`, for example:

```sh
DATABASE_URL=postgresql://paith:secret@db.example.com:5432/paith
```

## Optional: self-contained Postgres

If you want to run Postgres on the same host, `docker-compose.yml` includes a commented-out `db` service.

1. Uncomment the `db` service and `db_data` volume in `docker-compose.yml`.
2. Set `POSTGRES_PASSWORD` in `.env`.
3. Set `DATABASE_URL` in `.env` to:

```sh
DATABASE_URL=postgresql://paith:${POSTGRES_PASSWORD}@db:5432/paith
```

## DATABASE_URL options (SSL, search_path)

The application accepts `DATABASE_URL` in URL form (`postgresql://...`). Query parameters are mapped into the PostgreSQL PDO DSN.

Common parameters:

- `sslmode`
- `sslrootcert`
- `sslcert`
- `sslkey`
- `options` (e.g. `--search_path=...`)

Example with TLS verification:

```sh
DATABASE_URL=postgresql://user:pass@db.example.com:5432/paith?sslmode=verify-full&sslrootcert=/run/secrets/pg_ca.crt
```

Example setting `search_path` via libpq options:

```sh
DATABASE_URL=postgresql://user:pass@db.example.com:5432/paith?options=--search_path%3Dglobal
```

## Updating

```sh
docker compose pull
docker compose up -d
```
