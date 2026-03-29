# Paith Notes

[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=jbrosi_paith-notes&metric=coverage)](https://sonarcloud.io/summary/new_code?id=jbrosi_paith-notes)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=jbrosi_paith-notes&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=jbrosi_paith-notes)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=jbrosi_paith-notes&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=jbrosi_paith-notes)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=jbrosi_paith-notes&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=jbrosi_paith-notes)
[![Duplicated Lines (%)](https://sonarcloud.io/api/project_badges/measure?project=jbrosi_paith-notes&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=jbrosi_paith-notes)

Paith Notes is a self-hosted, markdown-first note system focused on small, linked documents, long-term portability, and honest trade-offs.

It is inspired by tools like Obsidian, but designed for the web, self-hosting, and controlled environments — without pretending to be Google Docs.

> ⚠️ **Status: early alpha — enthusiasts only.**
> The project is functional and self-hostable, but breaking changes will occur without notice.
> Do not rely on it for anything critical yet.

## The Name

**Paith** stands for **Personal AI and Trust** (or *faith* in the reliability of your own tools).

The name reflects the project's core conviction: AI should work *for* you, within boundaries *you* control — not the other way around.

## Philosophy

Paith Notes is built around a few deliberate constraints:

- **Notes are small.**\
  A note is the smallest unit. If you need large structures, you compose them via links, views, or filters — not giant documents.

- **Markdown is the source of truth.**\
  Notes are plain markdown. You can export them, inspect them, version them, and leave at any time.

- **Links matter more than hierarchy.**\
  Folders exist for navigation, not meaning. Backlinks and references are first-class features.

- **Portability over lock-in.**\
  You can export your notes and work with them in any editor. No proprietary format.

- **Honest security model.**\
  Paith Notes is *not end-to-end encrypted* by default. If you run the server, you control the data. No security theater.

- **Self-host first.**\
  Designed to be run by people who want control over their data and infrastructure.

- **AI as a tool, not a platform.**\
  AI assistance is built in, but isolated, optional, and never acts without your approval.
  See [Philosophy.md](./Philosophy.md) for the full rationale.

## Features

- Markdown notes with wiki-style `[[links]]`
- Backlinks and knowledge graph navigation
- Note types and structured properties
- Directed link predicates (knowledge graph)
- File attachments
- Nooks (isolated workspaces) with access control
- Built-in AI chat assistant (optional, isolated, approval-gated)
- MCP server for external AI tool access (optional)
- Web-based SPA frontend
- PostgreSQL backend
- Keycloak-based authentication
- Designed for self-hosting

## AI Integration

Paith Notes includes an optional AI assistant built around the principle of **explicit trust**.

- The AI service runs in a **separate, isolated container** — it is not part of the core application
- It is **entirely optional** — you can run Paith Notes without it
- Every action that reads or modifies your notes **requires your explicit approval** in the UI
- The AI operates under **your session and permissions** — it has no elevated access
- Read-only lookups and AI memory notes are the only things that run automatically

The AI is a tool. You are in control.

## Non-Goals

Paith Notes is not trying to be:

- Google Docs
- Notion
- A real-time collaborative editor
- A corporate wiki or knowledge base
- An AI content generation platform (AI assists *you*, it does not write *for* you)
- A "zero-knowledge" SaaS with unverifiable promises

If you need those things, this is probably the wrong tool — and that's intentional.

## Security & Privacy

- Paith Notes does not claim end-to-end encryption.
- If you control the server and the client, you control the data.
- If the browser or server is compromised, data is compromised — this is stated explicitly.
- If you need cryptographic guarantees against the operator of the service itself, this project is out of scope.

See [Security.md](./Security.md) for the full threat model.

## License

Paith Notes is licensed under the **AGPLv3**.

A commercial license may be available for organizations that require different terms.
This does not affect individual users or self-hosters.

Details will be documented clearly — no license bait-and-switch.

## Documentation

- [Architecture.md](./Architecture.md) — container topology, request flows, data storage
- [Deployment.md](./Deployment.md) — self-hosting guide, env vars, reverse proxy setup
- [deploy/host/README.md](./deploy/host/README.md) — production host deployment bundle and file templates
- [Philosophy.md](./Philosophy.md) — design principles and constraints
- [Security.md](./Security.md) — threat model and AI trust boundaries
- [Contributing.md](./Contributing.md) — how to contribute

## Contributing

The project is in early alpha. See [Contributing.md](./Contributing.md).

## Why this exists

Paith Notes exists because:

- personal notes should not require a cloud subscription
- markdown should remain portable
- AI should be a tool you trust, not a service that owns your data
- not every tool needs to scale to millions of users
- honesty about limitations is better than pretending they don't exist
