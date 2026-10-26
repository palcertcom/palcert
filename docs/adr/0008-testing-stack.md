# ADR-0008: Testing stack — Vitest, Jest and pytest

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

§39 requires unit, integration, API contract, end-to-end, security and golden
document tests, and forbids completing a phase with knowingly failing tests. The
workspace mixes framework-agnostic TypeScript packages, a decorator-heavy
NestJS application, a React application and a Python service.

## Decision

| Target | Runner | Reason |
| --- | --- | --- |
| `packages/*`, `apps/web` | **Vitest** | Fast, minimal config, native ESM and TSX |
| `apps/api` | **Jest + ts-jest** | `emitDecoratorMetadata` is required for NestJS dependency injection; esbuild (Vitest's default transform) does not emit it. `@nestjs/testing` is also Jest-first. |
| `services/document-engine` | **pytest** | Standard for FastAPI; `TestClient` boots the real app |

Golden document tests (from Phase 6) run under the API/engine runners with
fixtures in `test-documents/`, each with a documented expected result.

## Alternatives considered

- **Vitest everywhere with `unplugin-swc`.** Workable and tempting for
  consistency, but adds a transform plugin on the critical path of the most
  DI-dependent code. Revisit once Vitest supports decorator metadata natively.
- **Jest everywhere.** Rejected: materially slower and clumsier for the React
  and pure-TypeScript packages.

## Consequences

- Two JavaScript test runners to keep configured; `pnpm test` runs both via the
  workspace recursion, so contributors do not need to think about it.
- Assertion styles differ slightly between packages (`vi` vs `jest`).
