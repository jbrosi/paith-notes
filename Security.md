# Security Policy
## Scope

Paith Notes is a self-hosted, web-based note system.

The security model assumes:

- you control the server it runs on
- you control who has access to it
- you trust the infrastructure you deploy it on

Paith Notes does not attempt to protect users from a malicious server operator.

## Threat Model (Explicit)

Paith Notes does not provide end-to-end encryption by default.

This means:

- The server can read stored note contents.
- The application code served to the browser is trusted.
- If the server, browser, or deployment pipeline is compromised, data may be compromised.

This is a deliberate design decision to preserve:

- full-text search
- link indexing and graph features
- import/export portability
- debuggability and transparency

If you require cryptographic guarantees against the service operator itself, this project is out of scope.

## Browser Security

Paith Notes is a web application. As such:

- A successful XSS attack can access any data available to the user.
- A malicious browser extension can access rendered content.
- Session compromise compromises access.

## The project prioritizes:

- strict input validation
- aggressive output sanitization
- Content Security Policy (CSP)
- avoiding unsafe HTML rendering

But no browser-based application can fully protect against a compromised client.

## Local Caching

Optional local caching (if enabled) is intended only to protect against:

- offline disk access on shared or stolen devices

It does not protect against:

- malicious scripts
- compromised browsers
- authenticated attackers

Local caching should only be enabled on trusted devices.

## Reporting Security Issues

If you discover a security issue:

Do not open a public issue.

Please report it privately via email:

security@paith.me

Please include:

- a clear description of the issue
- steps to reproduce
- potential impact

Responsible disclosure is appreciated.

## Supported Versions

Paith Notes is currently pre-alpha.

- No production stability is guaranteed.
- Security fixes may not be backported.
- Breaking changes are expected.

Do not deploy this project in sensitive environments yet.

## Philosophy

Paith Notes values:

- transparency over marketing claims
- clear threat models over vague promises
- boring, understandable security over “magic”

Se
curity decisions are documented and intentional.
If something is not secure against a given threat, it is stated plainly.
