# ADR-0012: Argon2id for password hashing

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 1

## Context

Password hashing is the control that decides how bad a database breach is. The
choice must resist GPU and ASIC attack, allow cost to rise as hardware improves,
and never require a password reset to strengthen existing accounts.

## Decision

**Argon2id**, via `@node-rs/argon2`, with parameters from validated
configuration:

| Parameter | Default | Rationale |
| --- | --- | --- |
| `AUTH_ARGON2_MEMORY_KIB` | 19456 (19 MiB) | OWASP baseline for Argon2id |
| `AUTH_ARGON2_TIME_COST` | 2 | OWASP baseline for that memory cost |
| `AUTH_ARGON2_PARALLELISM` | 1 | OWASP baseline |

Supporting decisions:

- **Argon2id**, not `i` or `d`: the hybrid resists both side-channel and
  time-memory-tradeoff attack, which is what a server-side hash needs.
- **Parameters are configuration, not constants**, so cost can be raised without
  a code change.
- **Production has a floor.** Configuration validation rejects
  `NODE_ENV=production` with parameters below the baseline. Tests deliberately
  use weak parameters (1 MiB, t=1) so the suite stays fast; this floor is what
  makes that safe rather than a footgun waiting to be copied into a deployment.
- **Transparent rehash.** The Argon2 PHC string carries its own parameters, so
  after a successful login a hash below current policy is silently replaced.
  Raising the cost strengthens existing accounts over time with no user action.
- **`@node-rs/argon2`** rather than the `argon2` package: it ships prebuilt
  native binaries, so CI and container builds need no compiler toolchain.

## Alternatives considered

- **bcrypt.** Still acceptable, but its 72-byte input limit silently truncates
  long passphrases — unacceptable when we explicitly encourage them — and its
  fixed small memory footprint is friendly to GPU attack.
- **scrypt.** Reasonable, but Argon2id is the current recommendation and has
  clearer parameter guidance.
- **PBKDF2.** Only where FIPS compliance demands it; markedly weaker against
  parallel hardware.

## Consequences

- Login intentionally costs ~10-50 ms of CPU and 19 MiB of memory per attempt.
  That is the security property, not overhead to optimize away.
- Memory cost bounds concurrent logins per instance; throttling (ADR-0016) also
  limits how hard an attacker can push it.
- Passwords are normalized with NFKC before hashing so the same passphrase typed
  on different platforms verifies consistently. Nothing is trimmed or truncated.
