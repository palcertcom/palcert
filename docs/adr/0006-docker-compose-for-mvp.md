# ADR-0006: Docker Compose for the MVP, no Kubernetes

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

PalCert needs PostgreSQL, Redis and S3-compatible storage locally, and a
reproducible deployment path. §32 explicitly warns against introducing
Kubernetes during MVP development.

## Decision

- **Local development:** `docker/docker-compose.yml` runs PostgreSQL, Redis and
  MinIO. Application processes run on the host for fast reload.
- **Production images:** multi-stage Dockerfiles per deployable
  (`api`, `web`, `document-engine`), each running as a non-root user with a
  `HEALTHCHECK`.
- **Orchestration:** deferred. The images are orchestrator-agnostic, so moving
  to Kubernetes or a managed container platform later is a deployment change,
  not an application change.

## Alternatives considered

- **Kubernetes (or a local k3s/kind) now.** Rejected: large operational surface
  for a pre-launch product, and it slows every developer down daily.
- **Running applications in Compose too.** Rejected for the default workflow:
  container file-watching is slower and noticeably worse for debugging. Images
  are still built in CI so container drift is caught.

## Consequences

- Developers need Docker but not a cluster.
- Production deployment topology is decided in Phase 20, informed by real load
  testing, not guessed now.
