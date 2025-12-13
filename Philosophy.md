# Philosophy

Paith Notes is built around deliberate constraints.

- It is not an attempt to be everything for everyone.
- It is an attempt to be honest, portable, and understandable — even when that means saying no.

This document explains the guiding principles behind the project.

## 1. Notes over Documents

Paith Notes is centered around small, atomic notes.

A note is the smallest unit of meaning.
Large structures are created by linking notes together — not by growing documents endlessly.

This encourages:

- composability
- clarity
- reuse
- linking over hierarchy

If you want page layouts, complex formatting, or large collaborative documents, this project is intentionally not optimized for that.

## 2. Markdown as the Source of Truth

All content in Paith Notes is plain Markdown.

Markdown is:

- human-readable
- editor-agnostic
- versionable
- future-proof

Paith Notes does not invent a proprietary content format and does not require the application to understand your data.

You can:

- export your notes
- inspect them directly
- edit them outside the system
- leave at any time

Portability is not a feature — it is a requirement.

## 3. Links Matter More Than Hierarchy

Folders exist for navigation, not meaning.

Meaning emerges from:

- links
- backlinks
- references
- views and filters

Paith Notes intentionally avoids:

- virtual folders
- implicit duplication
- hidden structure

If something appears in multiple places, it should be explicit (a link), not an illusion.

## 4. Honest Security Model

Paith Notes is not end-to-end encrypted by default.

This is not an oversight. It is a conscious decision.

Why Paith Notes does not claim E2EE

In a web-based application:

- The server delivers the client code.
- Whoever controls the server can change that code.
- A modified client can exfiltrate encryption keys or plaintext data.
- Users cannot practically verify what code they are executing.
- Claiming “zero-knowledge” or “end-to-end encryption” in this model often relies on trusting the very party the encryption claims to protect against.

Paith Notes refuses to make that promise.

Instead, the project assumes:

- you control the server you run
- you trust the software you deploy
- you prefer transparency over cryptographic theater

What this enables

By not enforcing E2EE, Paith Notes can provide:

- server-side full-text search
- backlink and graph indexing
- reliable imports and exports
- debuggability
- predictable behavior

These features are difficult or impossible to provide honestly in a strict E2EE model without leaking metadata or shifting complexity to the client.

What this does not mean

This does not mean security is ignored.

Paith Notes still prioritizes:

- strong authentication
- clear access controls
- auditability
- input validation
- output sanitization
- defensive defaults

But it does not pretend to protect users from a malicious operator of the system itself.

## 5. Self-Hosting as the Trust Boundary

Paith Notes is designed to be self-hosted.

Self-hosting is the real trust boundary:

- you control where the data lives
- you control updates
- you control backups
- you control access

This model is simpler, more honest, and easier to reason about than promising cryptographic guarantees that depend on unverifiable assumptions.

## 6. Explicit Non-Goals

Paith Notes is intentionally not:

- a real-time collaborative editor
- a SaaS-first product
- an AI-generated content platform
- a corporate knowledge base
- a replacement for Google Docs or Notion

Features that conflict with the core principles above are unlikely to be accepted, even if they are popular.

## 7. Open Source with Boundaries

Paith Notes is open source because:

- transparency matters
- trust matters
- users should be able to inspect what they run

Open source does not mean:

- no opinions
- no boundaries
- no direction

Design decisions are intentional.
Not every feature request aligns with the project’s goals.

## Closing

Paith Notes prefers:

- clarity over cleverness
- boring correctness over hype
- explicit trade-offs over vague promises

If these constraints resonate with you, you will probably enjoy using — or contributing to — this project.

If they don’t, that’s okay.
There are many excellent tools optimized for different values.
