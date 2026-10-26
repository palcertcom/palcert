# ADR-0013: TOTP as the first multi-factor authenticator

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 1

## Context

Privileged PalCert roles can suspend accounts, grant roles and (from later
phases) issue refunds and revoke certificates. A password alone is not an
acceptable gate on those capabilities.

## Decision

**TOTP (RFC 6238)** is the Phase 1 factor, required for `PALCERT_ADMIN`,
`PALCERT_FINANCE` and `PALCERT_AUDITOR`, and available to any user.

- **SHA-1, 6 digits, 30-second period** — not a security compromise but an
  interoperability requirement: this is what authenticator apps implement. The
  HMAC construction is not affected by SHA-1's collision weaknesses.
- **±1 time step** of skew tolerance, per RFC 6238. Wider windows multiply the
  chance of a blind guess succeeding.
- **Replay protection.** `mfa_authenticators.last_accepted_counter` records the
  accepted time step; a code at or below it is refused. Without this, a code
  observed over someone's shoulder stays valid for the rest of its window.
- **Secrets encrypted at rest** with AES-256-GCM under `AUTH_MFA_SECRET_KEY`, so
  a database leak alone does not let an attacker mint valid codes.
- **Enrollment requires proof of possession.** Generating a secret does not
  enable MFA; only a verified code does. An unconfirmed authenticator never
  satisfies a challenge.
- **Recovery codes**: ten single-use codes, ~98 bits of entropy each, stored as
  SHA-256 digests and displayed exactly once. The alphabet excludes `O/0` and
  `I/1/l` because a human types these under stress.
- **Confirming enrollment from a pre-authentication session completes the
  login.** The user has just proven possession; making them wait 30 seconds for
  a fresh code purely to satisfy replay protection would be user-hostile for no
  security gain.

### Explicitly not implemented

- **SMS.** Vulnerable to SIM swap and SS7 interception; NIST SP 800-63B has
  restricted it since 2017. Not offered even as a fallback, because a fallback
  is exactly what an attacker would target.
- **Security questions.** Shared, guessable, and often public knowledge.
- **Email as a second factor.** The email account is usually the password-reset
  channel, so it is not an independent factor.

## Future factors

`mfa_authenticators.type` is an enum with one value today. WebAuthn/passkeys are
the intended next factor and are an additive change: a new enum value, a new
credential shape, and an extra branch in the challenge. Nothing about the
session or challenge flow needs to change.

## Consequences

- A privileged user who loses both their authenticator and their recovery codes
  needs an out-of-band administrative process. That is deliberate: any
  self-service path around MFA would become the weakest link.
- A privileged user cannot disable MFA; the role must be removed first.
