# ADR-0014: Layered CSRF protection

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 1

## Context

Cookie authentication means the browser attaches credentials automatically —
including on requests a hostile page caused. `SameSite=Lax` mitigates much of
this, but relying on it alone would be a mistake: it is a browser default that
varies by version and vendor, it does nothing for non-browser clients, and `Lax`
still permits top-level cross-site GET navigation.

## Decision

**Two independent layers**, both enforced by a global guard on every unsafe
method (`POST`, `PUT`, `PATCH`, `DELETE`).

### Layer 1 — Origin allow-list

The `Origin` header (falling back to `Referer`) must match the configured CORS
allow-list. This runs whether or not a session exists, which is what stops
**login CSRF** — an attacker submitting *their* credentials to plant a known
session in a victim's browser. A token check cannot defend against that, because
at that point there is no session to bind a token to.

A request carrying neither header passes to layer 2. That is a same-origin
server-to-server caller, which the token check still covers; rejecting it would
break legitimate API clients for no benefit. An explicitly opaque origin
(`Origin: null`, meaning a sandboxed iframe or `data:` document) is rejected.

### Layer 2 — Session-bound synchronizer token

- On session creation the server issues a second random token and stores its
  digest in `sessions.csrf_token_hash`.
- The raw value is delivered in the `palcert_csrf` cookie, which is deliberately
  **not** `HttpOnly` — the client must read it to echo it.
- Unsafe requests must send it in the `x-csrf-token` header; the digest must
  match the one bound to *this* session.

A cross-site attacker can cause the cookie to be *sent* but cannot *read* it, so
they cannot construct the header. Binding to the session (rather than a bare
double-submit) additionally defeats an attacker who can set cookies on a sibling
subdomain: a token from another session does not match.

`SameSite=Lax` is still set, as a third layer.

## Consequences

- Browser clients must read the CSRF cookie and echo it. `apps/web`'s API client
  does this centrally so no screen can forget.
- Adding an allowed front-end origin is a configuration change
  (`API_CORS_ORIGINS`), used by both CORS and CSRF so the two cannot drift.
- Future non-browser API clients (Phase 19+) will authenticate with a bearer
  credential rather than a cookie, and are therefore outside this mechanism by
  construction — no cookie, no CSRF exposure.
- Verified by test: untrusted origin, missing header, another session's token,
  login CSRF, and a token retired by session rotation are all rejected.
