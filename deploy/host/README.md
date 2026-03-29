# Host deployment template

This folder contains the production **pull-only** deployment bundle for Paith Notes.

For a full overview of the architecture and all configuration options, see:
- [`/Deployment.md`](../../Deployment.md) — complete deployment reference
- [`/Architecture.md`](../../Architecture.md) — container topology and request flows

---

## Assumptions

- You run **nginx (or any reverse proxy) on the host** for TLS termination.
- The app container listens on `127.0.0.1:8000` (HTTP, not exposed publicly).
- PostgreSQL is **external** (managed DB) or optionally self-contained (see below).
- Docker images are pulled from **GHCR** (published automatically by GitHub Actions on every push to `main`).

## Files

| File                      | Purpose                                                                                               |
|---------------------------|-------------------------------------------------------------------------------------------------------|
| `docker-compose.yml`      | Production compose file. Runs `app`, `worker`, `files`. MCP and Postgres are commented out as opt-in. |
| `.env.example`            | Template — copy to `.env` and fill in secrets.                                                        |
| `nginx-site.conf.example` | Host nginx vhost — proxies TLS → `http://127.0.0.1:8000`. Copy and adapt for your domain.             |
| `nginx.conf`              | Nginx config used **inside** the `files` container. Do not edit unless you know what you are doing.   |

## Setup

**1. Copy this folder to your server.**

```sh
scp -r deploy/host/ user@yourserver:/opt/paith-notes/
```

**2. Create your `.env` file.**

```sh
cp .env.example .env
```

Edit `.env` with your actual secrets and domain. The file contains comments explaining each value.

**3. Set your image references in `.env`.**

```sh
APP_IMAGE=ghcr.io/jbrosi/paith-notes/app:latest
WORKER_IMAGE=ghcr.io/jbrosi/paith-notes/worker:latest
```

**4. Pull and start.**

```sh
docker compose pull
docker compose up -d
```

**5. Configure your reverse proxy.**

Copy `nginx-site.conf.example` to `/etc/nginx/sites-available/paith-notes`, update the domain and certificate paths, then enable and reload:

```sh
sudo ln -s /etc/nginx/sites-available/paith-notes /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ **SSE required for AI chat:** If you use the MCP/chat feature, make sure `proxy_buffering off` is set in your proxy config. Without it, streaming responses will not work. The provided `nginx-site.conf.example` already includes this.

**6. Verify.**

```sh
curl http://127.0.0.1:8000/healthz
```

---

## Database options

### External Postgres (recommended)

Set `DATABASE_URL` in `.env`:

```sh
DATABASE_URL=postgresql://paith:secret@db.example.com:5432/paith
```

With TLS verification:

```sh
DATABASE_URL=postgresql://paith:secret@db.example.com:5432/paith?sslmode=verify-full&sslrootcert=/run/secrets/pg_ca.crt
```

### Self-contained Postgres (same host)

Uncomment the `db` service and `db_data` volume in `docker-compose.yml`, then set in `.env`:

```sh
POSTGRES_PASSWORD=your-password
DATABASE_URL=postgresql://paith:${POSTGRES_PASSWORD}@db:5432/paith
```

The schema is created automatically on first startup — no manual migrations needed.

---

## Keycloak setup

Paith Notes requires a Keycloak client configured as follows:

- **Client type**: OpenID Connect
- **Client authentication**: On (confidential client)
- **Valid redirect URIs**: `https://notes.example.com/api/auth/callback`
- **Valid post logout redirect URIs**: `https://notes.example.com`
- **Web origins**: `https://notes.example.com`

Set in `.env`:

```sh
KEYCLOAK_ENABLED=1
KEYCLOAK_BASE_URL=https://auth.example.com
KEYCLOAK_REALM=your-realm
KEYCLOAK_CLIENT_ID=paith-notes
KEYCLOAK_CLIENT_SECRET=your-client-secret
```

---

## Optional: MCP / AI service

Uncomment the `mcp` service in `docker-compose.yml`, then set in `.env`:

```sh
MCP_IMAGE=ghcr.io/jbrosi/paith-notes/mcp:latest
MCP_SERVER_URL=https://notes.example.com
ANTHROPIC_API_KEY=sk-ant-...
```

`API_BASE_URL` is already set to `http://app:8000` in the compose file and does not need to change.

The MCP service is routed automatically through the `app` container — no additional proxy rules are needed.

---

## Updating

```sh
docker compose pull
docker compose up -d
```

The database schema is updated automatically on startup.

---

## Backups

Back up two things:

1. **PostgreSQL database** — all structured data (notes, nooks, types, links, conversations)
2. **`files_data` Docker volume** — all uploaded files
