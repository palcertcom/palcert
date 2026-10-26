# ADR-0009: Structured logging and correlation IDs

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

A single PalCert check spans the web app, the API, a queue, a worker, the
document engine and (later) an AI provider. Diagnosing "my check failed"
requires stitching those hops together. Uploaded documents are confidential
unpublished academic material (§49), so logs must never become a data-leak
channel.

## Decision

- **Format:** JSON on every service. pino for TypeScript, structlog for Python.
  Pretty printing is a local-development option and is rejected by configuration
  validation in production.
- **Common fields:** `service`, `version`, `env`, `level`, `time`, `request_id`.
- **Correlation:** `x-request-id` is read from the inbound request when present
  (bounded to 128 characters to prevent log injection), generated as a UUIDv4
  otherwise, echoed on every response, and propagated to downstream services.
- **Redaction happens in the logger**, not at call sites: `authorization`,
  `cookie`, `set-cookie`, `x-api-key`, and any `password`, `token`, `secret`,
  `accessToken` or `refreshToken` field are replaced with `[REDACTED]`.
- **Levels:** 5xx → `error`, 4xx → `warn`, health probes → `debug`, otherwise
  `info`.
- **Never logged:** document contents, extracted document text, full request
  bodies.

## Alternatives considered

- **Plain-text logs.** Rejected: not queryable, and correlation becomes manual.
- **Redaction at call sites.** Rejected: one forgotten call site is a breach.

## Consequences

- Logs are directly ingestible by any structured log platform.
- Local readability depends on `LOG_PRETTY=true`, which production forbids.
- Adding a new sensitive field means updating the redaction list — covered by a
  unit test that asserts the list's contents.
