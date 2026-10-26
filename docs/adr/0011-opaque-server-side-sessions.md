# ADR-0011: Opaque server-side sessions, not browser-held JWTs

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 1

## Context

PalCert's browser clients need authenticated requests. The two common designs
are a self-contained token (JWT) held by the browser, or an opaque identifier
that means nothing without the server's session store.

PalCert's specific pressures: documents are confidential unpublished academic
material; an administrator's session grants the ability to suspend accounts and
assign roles; and users must be able to see and revoke their own devices.

## Decision

**Opaque, server-side sessions delivered in a cookie.**

- The session identifier is 32 random bytes, base64url-encoded.
- **PostgreSQL is the single source of truth.** A session is one indexed row.
- The raw token is **never stored**. The `sessions.token_hash` column holds its
  SHA-256 digest, so a database leak yields no directly replayable credential.
  SHA-256 (not Argon2) is correct here because the input is 256 bits of
  uniformly random data, not a low-entropy human secret.
- The cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`,
  with an explicit expiry. The identifier never appears in a URL, so it cannot
  leak through browser history, referrer headers or access logs.
- Two independent expiries: a rolling **idle** window and a hard **absolute**
  lifetime. Privileged roles get stricter values for both.
- A **new identifier is always issued** on authentication, MFA completion and
  password change. Sessions are replaced, never upgraded in place — which is
  what makes session fixation impossible rather than merely unlikely.

### Why not JWTs in the browser

- Revocation is the whole point. Logout-all, "sign out this device", suspension
  and password reset must take effect *now*. A stateless token cannot be
  withdrawn without a server-side deny-list — at which point the server is
  keeping session state anyway, with worse ergonomics.
- Any browser-accessible storage (`localStorage`, `sessionStorage`, a readable
  cookie) turns one XSS into stolen credentials.
- A JWT's claims go stale. Suspending an account or removing a role must not
  wait for a token to expire.

### Why PostgreSQL rather than Redis as the source of truth

Redis would make lookups marginally faster, but session state is *authorization*
state: a stale cache entry is an authorization bug, and revoke-all would have to
fan out cache invalidation correctly under every failure mode. A session lookup
is a single indexed query on a unique column. Correctness beats a micro-
optimization that has not been shown to be needed.

Redis **is** used in Phase 1, but only for data that is genuinely ephemeral and
where losing it is harmless: throttling counters.

## Consequences

- Every authenticated request performs a session lookup and a lightweight
  activity update. If profiling ever shows this to matter, a read-through cache
  can be added behind `SessionService` without changing any caller — but it
  would have to solve invalidation explicitly.
- Listing and revoking sessions is trivial, because sessions are rows.
- Horizontal scaling needs no sticky sessions: any instance can serve any
  session.
- Expired rows accumulate and will need periodic pruning (recorded as technical
  debt; `absolute_expires_at` is indexed for exactly this).
