# ADR-0015: Administrator bootstrap by explicit CLI

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 1

## Context

A fresh PalCert deployment has no users, and no one who can grant the
`PALCERT_ADMIN` role. Something has to create the first administrator, and that
something is by definition a privilege-escalation mechanism — so its design
matters more than its convenience.

## Decision

A **deliberately invoked command**, `apps/api/src/cli/bootstrap-admin.ts`, run
by an operator with direct access to the deployment environment:

```bash
PALCERT_BOOTSTRAP_ADMIN_EMAIL=ops@palcert.com \
PALCERT_BOOTSTRAP_ADMIN_PASSWORD='…' \
node dist/cli/bootstrap-admin.js
```

Properties, each present for a reason:

- **Not reachable over HTTP.** There is no endpoint, not even a disabled or
  guarded one. An endpoint that must never be called is an endpoint that will
  eventually be called.
- **Idempotent.** Re-running promotes the existing account instead of failing or
  duplicating, so it is safe to leave in a deployment pipeline.
- **Never weakens an existing account.** If the address already exists, the role
  is granted and *nothing else changes* — in particular the password is not
  reset. Otherwise anyone able to run the command could take over an existing
  administrator's account.
- **Prints no secret.** The password comes from the environment and is never
  echoed; the command reports only the address it acted on.
- **MFA still applies.** The created account holds `PALCERT_ADMIN`, which
  requires MFA, so the first sign-in must enrol a second factor before the
  account can do anything at all.
- **Audited.** The promotion writes an `ADMIN_BOOTSTRAP` audit record and a
  `ROLE_ASSIGNED` security event, so it is visible in the same place as every
  other privileged change.

## Alternatives considered

- **A seed script that creates a fixed admin.** Rejected: a known default
  credential in source is a breach waiting to happen, and seeds get run in
  production by accident.
- **First registered user becomes admin.** Rejected: a race against any attacker
  who can reach the deployment before the operator does.
- **A one-time setup URL.** Rejected: it must be transmitted, may be logged,
  and the "one-time" state is another thing to get wrong.

## Consequences

- Bootstrapping requires deployment access, which is the correct bar.
- The operator supplies the password out of band; PalCert never generates or
  displays one.
- Documented in `docs/security/admin-bootstrap.md`.
