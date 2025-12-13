# Paith Notes

Paith Notes is a self-hosted, markdown-first note system focused on small, linked documents, long-term portability, and honest trade-offs.

It is inspired by tools like Obsidian, but designed for the web, self-hosting, and controlled environments — without pretending to be Google Docs.

> ⚠️ Status: pre-alpha.
> The project is under active development and not usable yet. Expect breaking changes.

## Philosophy

Paith Notes is built around a few deliberate constraints:
- **Notes are small.**\
A note is the smallest unit. If you need large structures, you compose them via links, views, or filters — not giant documents.

- **Markdown is the source of truth.**\
Notes are plain markdown. You can export them, inspect them, version them, and leave at any time.

- **Links matter more than hierarchy.**\
Folders exist for navigation, not meaning. Backlinks and references are first-class features.

- **Portability over lock-in.**\
You can export a vault, work with it in Obsidian (or any editor), and re-import it later.

- **Honest security model.**\
Paith Notes is *not end-to-end encrypted* by default. If you run the server, you control the data. No security theater.

- **Self-host first.**\
This project is designed to be run by people who want control over their data and infrastructure.

## Non-Goals

Paith Notes is not trying to be:

- Google Docs
- Notion
- A real-time collaborative editor
- A corporate wiki or knowledge base
- An AI-generated content platform
- A “zero-knowledge” SaaS with unverifiable promises

If you need those things, this is probably the wrong tool — and that’s intentional.

## Key Characteristics (planned)

- Markdown notes with wiki-style links
- Backlinks and graph-style navigation
- Folders + tags (no virtual folders)
- Drafts with explicit publish
- Full export to plain markdown + folders
- Import from exported vaults
- Web-based SPA frontend
- PostgreSQL backend
- Designed for self-hosting

Details will evolve, but the philosophy will not.

## Security & Privacy

- Paith Notes does not claim end-to-end encryption.
- If you control the server and the client, you control the data.
- Optional encrypted local caching may be supported for trusted devices.
- If the browser or server is compromised, data is compromised — this is stated explicitly.
- If you need cryptographic guarantees against the operator of the service itself, this project is out of scope.

## License

Paith Notes is licensed under the **AGPLv3**.

A commercial license may be available for organizations that require different terms.
This does not affect individual users or self-hosters.

Details will be documented clearly — no license bait-and-switch.

## Contributing

The project is still in early development.
At this stage, feedback and design discussion are more useful than feature PRs.

If you want to contribute code later, please note that contributions must be compatible with the project’s licensing model.

## Why this exists

Paith Notes exists because:

- personal notes should not require a cloud subscription
- markdown should remain portable
- not every tool needs to scale to millions of users
- honesty about limitations is better than pretending they don’t exist

