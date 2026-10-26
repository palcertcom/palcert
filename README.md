# PalCert

AI-powered document compliance, correction, verification and certification for
universities, scientific journals, publishers and research institutions.

```
Define → Check → Fix → Verify → Approve → Certify
```

PalCert lets an organization define its formatting and document requirements,
checks uploaded DOCX/PDF documents against a specific immutable standard
version, optionally repairs safe formatting violations (SmartFix), routes
compliant documents for institutional approval, and issues a verifiable
certificate.

> **Status: v1 — phases 0 to 20 are complete.** See
> [`docs/requirements/phases.md`](docs/requirements/phases.md) for what each
> phase delivered.

## Repository layout

```
apps/
  api/                  NestJS core backend (modular monolith)
  web/                  Next.js frontend (Arabic/English, RTL-first)
services/
  document-engine/      Python/FastAPI document intelligence service
packages/
  contracts/            Shared types, error codes, API constants
  config/               Centralized, validated configuration schemas
  database/             Prisma schema, migrations and client factory
docker/                 Local infrastructure and production images
docs/
  architecture/         System architecture
  adr/                  Architecture decision records
  requirements/         Product requirements and phase plan
  security/             Security baseline and threat model
  api/                  API conventions
tests/                  Cross-service test assets
test-documents/         Golden document fixtures (from Phase 6)
infra/                  Deployment/ops assets
```

Directories are created when their phase begins — the tree above reflects what
exists today.

## Quick start

Prerequisites: Node 22, pnpm 10, Python 3.11, Docker.

```bash
cp .env.example .env          # local placeholders only — never real secrets
pnpm install
pnpm docker:up                # PostgreSQL, Redis, MinIO
pnpm db:generate && pnpm db:migrate
pnpm dev                      # API on :4000, web on :3000
```

Document engine:

```bash
cd services/document-engine
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

Full instructions: [`docs/architecture/development-setup.md`](docs/architecture/development-setup.md).

### Persistent full stack

The whole product behind TLS at <https://localhost:8443>, built from the
working tree, with data that survives rebuilds and restarts:

```bash
pnpm local:up        # build and start (never deletes data)
pnpm local:status    # containers, volumes, URL
pnpm local:stop      # stop (never deletes data)
pnpm local:reset     # delete all local data — asks for confirmation
```

See [`docs/operations/local-environment.md`](docs/operations/local-environment.md).

## Verifying the stack

| Check | Command / URL |
| --- | --- |
| API liveness | `curl localhost:4000/health/live` |
| API readiness | `curl localhost:4000/health/ready` |
| API docs | <http://localhost:4000/api/docs> |
| Web (English) | <http://localhost:3000/en> |
| Web (Arabic, RTL) | <http://localhost:3000/ar> |
| Document engine | `curl localhost:8000/health/live` |

## Commands

| Command | Description |
| --- | --- |
| `pnpm lint` / `pnpm lint:fix` | ESLint across the TypeScript workspace |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm typecheck` | TypeScript project-wide type check |
| `pnpm test` | Unit and integration tests (all packages) |
| `pnpm --filter @palcert/api test:e2e` | API end-to-end tests (needs infra up) |
| `pnpm py:lint` / `pnpm py:test` | Document engine lint and tests |
| `pnpm db:migrate` | Create/apply a development migration |

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Architecture decision records](docs/adr/README.md)
- [Product requirements](docs/requirements/product-overview.md)
- [Phase plan](docs/requirements/phases.md)
- [Security baseline](docs/security/baseline.md)
- [API conventions](docs/api/conventions.md)
- [Coding standards](docs/architecture/coding-standards.md)
