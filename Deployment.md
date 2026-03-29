# Deployment

This guide covers self-hosting Paith Notes in production using Docker Compose.

> ⚠️ Paith Notes is early alpha. Breaking changes will occur. Do not use for anything critical.

The production deployment template lives in `deploy/host/`. Use the files there as the source of truth for host deployments.

## Prerequisites

- Docker + Docker Compose v2
- A reverse proxy with TLS termination (Caddy, nginx, Traefik, etc.)
- A running Keycloak instance (external — not managed by this repo)
- A domain name

## Docker Images

Production images are published to GitHub Container Registry on every push to `main`:

| Service                  | Image                                      |
|--------------------------|--------------------------------------------|
| App (PHP API + Frontend) | `ghcr.io/jbrosi/paith-notes/app:latest`    |
| Worker                   | `ghcr.io/jbrosi/paith-notes/worker:latest` |
| MCP (AI, optional)       | `ghcr.io/jbrosi/paith-notes/mcp:latest`    |

## Quick Start

**1. Copy `deploy/host/` to your server.**

That directory contains the production `docker-compose.yml`, `.env.example`, and nginx examples.

**2. Create your env/config files** from the templates in `deploy/host/`.

- Copy `.env.example` to `.env` and fill in your values
- Review `deploy/host/README.md` for the complete host setup flow

**3. Pull and start:**

```sh
docker compose pull
docker compose up -d
```

**4. Point your reverse proxy** at port `8000` on the `app` container.

## Environment Variables

### Required

| Variable                 | Description                                                                  |
|--------------------------|------------------------------------------------------------------------------|
| `APP_IMAGE`              | Full image ref, e.g. `ghcr.io/jbrosi/paith-notes/app:latest`                 |
| `WORKER_IMAGE`           | Full image ref, e.g. `ghcr.io/jbrosi/paith-notes/worker:latest`              |
| `DATABASE_URL`           | PostgreSQL connection string, e.g. `postgresql://paith:secret@db:5432/paith` |
| `KEYCLOAK_ENABLED`       | Set to `1` to enable Keycloak auth                                           |
| `KEYCLOAK_BASE_URL`      | Keycloak base URL, e.g. `https://auth.example.com`                           |
| `KEYCLOAK_REALM`         | Keycloak realm name                                                          |
| `KEYCLOAK_CLIENT_ID`     | Keycloak client ID for the app                                               |
| `KEYCLOAK_CLIENT_SECRET` | Keycloak client secret                                                       |
| `SESSION_SECRET`         | Random secret for session signing (generate with `openssl rand -hex 32`)     |
| `PUBLIC_BASE_URL`        | Public URL of the app, e.g. `https://notes.example.com`                      |

### AI / MCP (optional)

Only required if you run the `mcp` service.

| Variable            | Description                                                  |
|---------------------|--------------------------------------------------------------|
| `MCP_IMAGE`         | Full image ref, e.g. `ghcr.io/jbrosi/paith-notes/mcp:latest` |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required for chat to work)           |
| `MCP_SERVER_URL`    | Public URL of the app, e.g. `https://notes.example.com`      |

`API_BASE_URL` defaults to `http://app:8000` and typically does not need to be changed.

See `deploy/host/.env.example` for a complete annotated configuration reference.

## Reverse Proxy

The `app` container listens on port `8000` and handles all routing internally (API, frontend, file serving, and MCP if running). You only need to proxy a single port.

### Caddy example

```
notes.example.com {
    reverse_proxy app:8000
}
```

If running the `mcp` service on the same network, it is already proxied by the `app` container — no additional proxy rules needed.

### Nginx example

```nginx
server {
    listen 443 ssl;
    server_name notes.example.com;

    location / {
        proxy_pass http://app:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE (AI chat streaming)
        proxy_buffering off;
        proxy_cache off;
    }
}
```

> The AI chat uses Server-Sent Events (SSE). Make sure `proxy_buffering off` is set, otherwise responses will not stream.

## Keycloak Setup

Paith Notes requires a Keycloak client configured as follows:

- **Client type**: OpenID Connect
- **Client authentication**: On (confidential client)
- **Valid redirect URIs**: `https://notes.example.com/api/auth/callback`
- **Valid post logout redirect URIs**: `https://notes.example.com`
- **Web origins**: `https://notes.example.com`

The client secret goes in `KEYCLOAK_CLIENT_SECRET`.

## Database

Paith Notes manages its own schema via `GlobalSchema::ensure()` which runs on startup — no manual migrations needed. The schema is fully idempotent.

If you use the `db` service from the provided `docker-compose.yml`, the database is created automatically. For an external PostgreSQL instance, create the database and user manually:

```sql
CREATE USER paith WITH PASSWORD 'yourpassword';
CREATE DATABASE paith OWNER paith;
```

## File Storage

Uploaded files are stored on the `files_data` Docker volume, shared between the `app`, `worker`, and `files` containers. There is no S3 or external storage dependency by default.

Back up this volume alongside your PostgreSQL database.

## Updates

```sh
docker compose pull
docker compose up -d
```

The schema is updated automatically on startup. No manual migration steps are required.

## Health Check

```sh
curl https://notes.example.com/healthz
```

Returns `200 OK` if the app is running.
