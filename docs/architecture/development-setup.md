# Development setup

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.x | `.nvmrc` pins the exact version |
| pnpm | 10.x | `corepack enable` installs it from `packageManager` |
| Python | 3.11+ | For the document engine |
| Docker | 24+ | PostgreSQL, Redis, MinIO |

## 1. Clone and configure

```bash
git clone https://github.com/raedrasheed/PalCert-2027.git palcert
cd palcert
cp .env.example .env
```

`.env.example` contains local placeholders only. Never put a real secret in a
committed file. Generate a development session secret with:

```bash
openssl rand -base64 48
```

`AUTH_MFA_SECRET_KEY` is deliberately left empty in the template and you must
generate your own before the API will start:

```bash
openssl rand -base64 32
```

Any value valid there is 32 base64 bytes, which no reader and no secret scanner
can tell apart from real key material — so the template ships none rather than a
shared "dev key" that works well enough to be pasted somewhere it should not be.

## 2. Install dependencies

```bash
corepack enable
pnpm install
```

## 3. Start infrastructure

```bash
pnpm docker:up
```

| Service | Port | Credentials (local only) |
| --- | --- | --- |
| PostgreSQL | 5432 | `palcert` / `palcert_local_dev` |
| Redis | 6379 | none |
| MinIO API | 9000 | `palcert_local_dev` / `palcert_local_dev_secret` |
| MinIO console | 9001 | same |
| ClamAV (clamd) | 3310 | none — downloads signatures on first start (a few minutes) |

Stop with `pnpm docker:down`; add `-v` to the compose command to discard data.

## 4. Prepare the database

```bash
pnpm db:setup        # generate, apply migrations, provision the app role
```

That is three steps, and the third one matters:

```bash
pnpm db:generate            # generate the Prisma client
pnpm db:deploy              # apply committed migrations (as the schema owner)
pnpm db:provision-app-role  # give the least-privileged request role a password
```

PalCert uses **two database identities** (ADR-0018). `DATABASE_ADMIN_URL` owns
the schema and runs migrations; `DATABASE_URL` is the request path and is
deliberately unable to bypass row-level security. The API checks this at boot
and refuses to start if the request role is a superuser or holds `BYPASSRLS` —
so skipping the provisioning step produces a clear failure rather than a silent
loss of tenant isolation.

### Object storage buckets

```bash
pnpm storage:provision
```

Creates the clean, quarantine and derived buckets (`STORAGE_BUCKET`,
`STORAGE_QUARANTINE_BUCKET`, `STORAGE_DERIVED_BUCKET`), enables versioning,
blocks public access, sets CORS for `API_CORS_ORIGINS` and applies the
lifecycle rules. The derived bucket deliberately gets no CORS: analysis
artifacts are internal, and no browser reaches them. Idempotent; run it again
after changing origins. Nothing needs the MinIO console.

During development, `pnpm db:migrate` creates and applies a new migration from
schema changes. Note that it runs as the owner, and the owner is subject to
`FORCE ROW LEVEL SECURITY` too: a migration that needs to touch tenant rows must
`SET row_security = off` explicitly.

## 5. Run the applications

```bash
pnpm dev             # API on :4000 and web on :3000
```

Individually:

```bash
pnpm --filter @palcert/api dev
pnpm --filter @palcert/web dev
pnpm --filter @palcert/api dev:worker   # file-processing worker (Phase 5, 6), :4100
```

Uploads stay `UPLOADED` until a worker runs. With `MALWARE_SCANNER=clamav`
the worker's readiness is amber until clamd has loaded its signatures; set
`MALWARE_SCANNER=fake` only for local experiments (production refuses it).

Document engine:

```bash
cd services/document-engine
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

## 6. Verify

```bash
curl -s localhost:4000/health/live  | jq
curl -s localhost:4000/health/ready | jq   # 503 until infrastructure is up
curl -s localhost:8000/health/live  | jq
open http://localhost:4000/api/docs
open http://localhost:3000/en
open http://localhost:3000/ar        # renders right-to-left
```

## 7. Creating an administrator

A local deployment has no users. Register normally at
<http://localhost:3000/en/register> for an ordinary account, or create a
platform administrator:

```bash
pnpm --filter @palcert/api build
PALCERT_BOOTSTRAP_ADMIN_EMAIL=you@example.com \
PALCERT_BOOTSTRAP_ADMIN_PASSWORD='a-long-development-passphrase' \
node apps/api/dist/cli/bootstrap-admin.js
```

The account requires MFA, so the first sign-in walks through enrollment. See
[admin bootstrap](../security/admin-bootstrap.md).

Verification and reset emails have no transport configured in development: the
`LoggingMailDelivery` adapter records that mail was produced without sending it,
and deliberately never logs the token. To complete a local flow, read the token
from the database:

```bash
docker exec palcert-postgres psql -U palcert -d palcert -c \
  "SELECT user_id, expires_at FROM email_verification_tokens WHERE consumed_at IS NULL;"
```

Only the digest is stored, so the raw token cannot be recovered — use the test
suite's `InMemoryMailOutbox` when you need the actual link, or point
`MailDeliveryPort` at a local SMTP catcher.

## 8. Quality gates

Run these before pushing — CI runs the same commands:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @palcert/api test:e2e   # requires PostgreSQL, Redis and MinIO (provisioned)
CLAMAV_INTEGRATION=1 pnpm --filter @palcert/api test -- clamav-scanner.integration  # optional, live clamd

cd services/document-engine
ruff check . && ruff format --check . && mypy app && pytest
```

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| API exits immediately with a list of config problems | Configuration validation failed (exit code 78). Fix the listed variables in `.env`. |
| `/health/ready` returns 503 | PostgreSQL or Redis is not reachable. Check `pnpm docker:logs`. |
| `Cannot find module '../generated/client'` | Run `pnpm db:generate`. |
| Type errors referencing `@palcert/contracts` | Build workspace packages: `pnpm -r --filter "./packages/**" build`. |
| API exits with "can bypass row-level security" | `DATABASE_URL` points at the owner. Use the `palcert_app` URL from `.env.example` and run `pnpm db:provision-app-role`. |
| `password authentication failed for user "palcert_app"` | The role exists but has no password yet — run `pnpm db:provision-app-role`. |
| A tenant query returns nothing that should be there | It ran outside a tenant context. Wrap it in `TenantPrismaService.withTenant`. |
| `new row violates row-level security policy` | A write targeted a different organization than the resolved tenant. |
| Port already in use | Change `API_PORT` / `DOC_ENGINE_PORT` / `WORKER_PORT` in `.env`. |
| Version creation returns `STORAGE_UNAVAILABLE` | MinIO is down or the buckets do not exist — `pnpm storage:provision`. |
| Browser upload fails with a CORS error | The web origin was not in `API_CORS_ORIGINS` when the buckets were provisioned; re-run `pnpm storage:provision`. |
| `/health/ready` on the worker is 503 on `malware-scanner` | clamd is still loading signatures, or `CLAMAV_HOST`/`CLAMAV_PORT` are wrong. |
| Uploaded versions never leave `UPLOADED` | No worker running: `pnpm --filter @palcert/api dev:worker`. |
| Analyses stay `PENDING` | Same: no worker. Analysis reuses the Phase 5 ledger. |
| Analyses fail with `ENGINE_UNAVAILABLE` | The document engine is not running, or `DOC_ENGINE_URL` is wrong. Start it with `uvicorn app.main:app --port 8000`. |
| Checks fail with `RULE_ENGINE_FAILED` | Same service, same URL: the rule engine is `POST /evaluation` on the document engine. Check it with `curl localhost:8000/evaluation/capabilities`. |
| The catalogue is empty | A standard appears only when its organization is active and VERIFIED, the standard is active with a PUBLISHED version, and someone set `checkAvailability` to `PUBLIC_CHECKABLE` via `PATCH /organizations/:id/standards/:id/check-availability`. The default is PRIVATE, deliberately. |
| CI fails on "the report golden is out of date" | Report canonicalization changed. If that was deliberate, it is a versioned decision: raise `REPORT_CANONICALIZATION_VERSION` and keep the old golden, so reports already issued still verify. |
| `POST /checks/:id/ai-reviews` returns `AI_DISABLED` | AI is off by default. Set `AI_ENABLED=true` and provide `ANTHROPIC_API_KEY`. |
| API exits with "the fake AI provider must not be used in production" | `AI_PRIMARY_PROVIDER=fake` with `NODE_ENV=production`. The double invents assessments; it must never serve a real user. |
| API exits with "ANTHROPIC_API_KEY is required" | AI is enabled with the anthropic provider but no key was supplied. |
| AI reviews stay `QUEUED` | No worker running: `pnpm --filter @palcert/api dev:worker`. AI review reuses the Phase 5 job ledger. |
| A review fails with `AI_CONSENT_REQUIRED` | The user has not agreed to external processing yet — `POST /ai/consent`. Nothing is sent before they do. |
| A review fails with `EVIDENCE_INTEGRITY_FAILED` | The report, analysis artifact, document or standard snapshot the review was bound to no longer matches. This is the check failing closed, not a bug: start a fresh check. |
| A review fails with `OUTPUT_INVALID` | The model returned a rule that was not requested, omitted one that was, or cited a node id PalCert never supplied. Nothing is stored; the model's text is deliberately not recorded. |
| A review fails with `CONTEXT_TOO_LARGE` | The selected evidence exceeds `AI_MAX_INPUT_TOKENS`. Lower `AI_MAX_RULES_PER_REQUEST` or `AI_MAX_CONTEXT_NODES` rather than raising the budget blindly. |
| `/health/ready` is green but AI does not work | By design: `/health/ready` never probes the provider. Use `GET /api/health/ai`. |
| The live Anthropic smoke test is skipped | Expected. It runs only when a real key is present; normal CI needs none. |
| `POST .../sources` returns `STANDARD_VERSION_NOT_DRAFT` | Sources attach to drafts only. Clone the version, or work on the draft. |
| A source stays `UPLOADED` and never reaches `READY` | No worker running: `pnpm --filter @palcert/api dev:worker`. Source ingestion reuses the Phase 5 job ledger. |
| A source is `REJECTED` with `FILE_MACRO_UNSUPPORTED` | A macro-enabled Word file. PalCert does not open macros, for guidelines exactly as for theses. Save the guideline as a plain `.docx` or `.pdf`. |
| `POST .../extractions` returns `ORGANIZATION_AI_CONSENT_REQUIRED` | The **institution** has not agreed. A personal Phase 8 consent does not count and is never consulted here — `POST /organizations/:id/ai-consent` as an organization administrator. |
| `POST .../ai-consent` returns 403 for a template manager | Working with templates does not carry the authority to commit the institution to external processing. Ask an organization administrator. |
| `POST .../extractions` returns `EXTRACTION_NO_USABLE_SOURCES` | Nothing on the draft is `READY`: every source is still processing, or all were rejected. |
| An extraction fails with `NO_EVIDENCE_DISCOVERED` | The provider cited nothing in the sources supplied. Usually a scanned PDF with no text layer, or a template uploaded as a guideline. |
| An extraction fails with `SOURCE_TOO_LARGE` | The discovered evidence exceeds `AI_EXTRACTION_MAX_CONTEXT_CHARS`. Split the guidelines or run over fewer sources rather than raising the budget blindly. |
| An extraction fails with `SOURCE_INTEGRITY_FAILED` | A bound source's digest no longer matches what the run recorded. Failing closed, not a bug: start a fresh run. |
| Accepting a proposal returns `STALE_STANDARD_REVISION` | The draft changed while the page was open. Reload and decide against what the draft says now. |
| Accepting returns `RULE_PROPOSAL_NOT_ACCEPTABLE` | The proposal carries no valid rule — it is ambiguous, conflicting, unrepresentable, or it failed PalCert's own rule validation. That is the design: write the rule yourself. |
| Deleting a source returns `STANDARD_SOURCE_RETENTION_LOCKED` | An accepted rule cites it. Removing it would destroy the evidence behind the standard. |
| Proposals are produced but every one is `INVALID` | Almost always a rule-schema drift: run `pnpm --filter @palcert/contracts build` so `rule-proposal.schema.json` and the generated types agree with the Rule Schema. |
| `POST /balance/top-ups` returns `PAYMENTS_DISABLED` | Payments are off. Set `PAYMENTS_ENABLED=true`; for local work keep `PAYMENT_PROVIDER=fake`. |
| API exits with "the fake payment provider must not be used in production" | `PAYMENT_PROVIDER=fake` with `NODE_ENV=production`. The double invents payments; it must never handle real money. |
| API exits with "STRIPE_SECRET_KEY is required" | Payments are enabled with the stripe provider and no key was supplied. Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, or switch to `PAYMENT_PROVIDER=fake` locally. |
| A top-up stays `PENDING` after paying | Either no worker is running (`pnpm --filter @palcert/api dev:worker` — payment events use the Phase 5 job ledger), or no webhook reached PalCert. Reconciliation picks it up after `PAYMENT_RECONCILE_AFTER_SECONDS` either way. |
| A webhook returns 400 `WEBHOOK_SIGNATURE_INVALID` | The signature is checked against the exact raw bytes. A proxy that reformats the body, or the wrong `STRIPE_WEBHOOK_SECRET`, breaks it. Do not "fix" it by relaxing verification. |
| A top-up is `RECONCILIATION_REQUIRED` | The provider's amount, currency or client reference disagreed with PalCert's row. Deliberate: a person looks. Nothing is credited by guessing. |
| Balance is credited after the redirect, not on it | By design. The return page only *asks* for the top-up's status; credit comes from a verified provider event or PalCert's own re-query. |
| Spending fails with 402 `INSUFFICIENT_BALANCE` | Available balance is the ledger balance minus **active holds**. Something is reserved; `GET /balance/holds` says what. |
| An external refund fails with `REFUND_NOT_ELIGIBLE` | The credit is promotional. Promotional credit is never refundable to a card, structurally — a database CHECK refuses it. |
| Activating a price fails with `PRICE_ALREADY_ACTIVE` | Another active version already covers that product, currency and market. Activation retires the incumbent; it does not stack. |
| Editing an active price fails with `PRICE_IMMUTABLE` | Active prices do not change. Create a new version and activate it. |
| `GET /pricing/quote` returns `PRICE_NOT_AVAILABLE` | No active price in that currency. Phase 10 never converts from another one. |
| A ledger `UPDATE` or `DELETE` fails in psql | Working as designed, from every role including the owner. Append a compensating entry instead. |
| `/health/ready` is green but payments do not work | By design: readiness never probes the payment provider. Use `GET /api/health/payments`. |
| `POST /checks` returns 422 `priceQuoteId must be a UUID` | Checks are paid for since Phase 11. Ask for a price first — `GET /pricing/quote?product=DOCUMENT_CHECK` — and send the quote's id. |
| `POST /checks` returns 402 `INSUFFICIENT_BALANCE` | Available balance is the ledger balance minus active holds. Nothing was created: no check, no purchase, no hold, and the quote is still usable. |
| `POST /checks` returns 409 `QUOTE_ALREADY_USED` | A quote funds one purchase. A second check needs a second quote. |
| `POST /checks` returns 409 `QUOTE_EXPIRED` | The price is no longer current. Ask for a new quote; PalCert never reprices one silently. |
| `POST /checks` returns 404 `QUOTE_NOT_FOUND` for a quote you can see in the database | It belongs to a different user. Another customer's quote answers 404, not 403. |
| A check stays `CREATED` and nothing happens | No worker running: `pnpm --filter @palcert/api dev:worker`. Creation writes a durable `CHECK_PREPARE` intent; the worker is what consumes it. |
| A check failed and the balance came back, but no refund appears in the history | Correct. Nothing was charged, so there is nothing to refund — the reservation was released, which writes no ledger entry. |
| A NON_COMPLIANT check was charged | By design. The customer bought the analysis and the report, not a passing result. |
| `POST /checks/:id/retry` returns 409 `CHECK_RETRY_REQUIRES_NEW_PURCHASE` | A paid check is not retried in place. No charge was made; run a new check at the current price. |
| `POST /checks/:id/cancel` returns 409 `SERVICE_ALREADY_DELIVERED` | The report exists, so the service was delivered. Cancellation is only possible before that. |
| A check failed with `SERVICE_RESERVATION_EXPIRED` | It took longer than `CHECK_RESERVATION_TTL_SECONDS`. The reservation was released and nothing was charged; raise the TTL if your infrastructure is slow. |
| A direct INSERT into `document_checks` fails with "must be bound to a service purchase" | Working as designed, from every role. The free check path was retired in Phase 11; historical rows are untouched. |
| A transaction fails at COMMIT with "is funded by N but costs M" | A deferred constraint trigger. Allocations must sum to the purchase amount — the transaction is refused whole, not partially applied. |
| `GET /checks/:id` shows `billing: null` | A historical check created before Phase 11. `legacyFree` is `true`; PalCert does not invent a purchase for one. |
| `AUTH_MFA_SECRET_KEY: must be exactly 32 bytes` | Generate one with `openssl rand -base64 32`. |
| Login returns `CSRF_INVALID` | The request's `Origin` is not in `API_CORS_ORIGINS`, or the `x-csrf-token` header is missing. |
| Admin login returns `MFA_ENROLLMENT_REQUIRED` | Expected: privileged roles must enrol a second factor before use. |

## Authoring a migration

`prisma migrate diff` generates the table and index DDL, but Prisma's schema
language cannot model several constructs PalCert relies on, and it therefore
re-emits `DROP` statements for them on **every** diff, believing they are drift:

- the composite foreign keys on `user_roles` and `organization_invitations`;
- the composite foreign keys carrying `organization_id` on the standards tables;
- `table_isolation_classification`.

Applying those drops would silently delete tenant guarantees and the RLS
coverage catalogue. The workflow is therefore:

1. generate with
   `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url … --script`;
2. **delete every `DROP` the generator emitted for a construct it cannot model**
   — check that no `DROP` remains that you did not intend;
3. append the hand-written sections (composite keys, check constraints,
   triggers, `table_isolation_classification` rows, RLS policies, grants,
   permission seeding) as numbered blocks with comments explaining *why*;
4. replay from a clean database and from each previous phase's database.

Never edit an applied migration (§45).

### Local services without Docker

The compose file is the documented path, but the services can also be run
directly, which is what CI and remote sessions do:

```bash
pg_ctlcluster 16 main start
redis-server --daemonize yes
psql -c "CREATE ROLE palcert LOGIN SUPERUSER PASSWORD 'palcert_local_dev'"
psql -c "CREATE DATABASE palcert OWNER palcert"
pnpm db:setup           # generate + migrate deploy + provision-app-role
```

`db:provision-app-role` grants `LOGIN` to `palcert_app` from `APP_DB_PASSWORD`.
It strips Prisma-only query parameters (`?schema=`) from the connection string
before handing it to `psql`, which rejects them.

### Dropping the database

Always `DROP DATABASE … WITH (FORCE)`. Without it the drop fails silently when a
connection is open, and a later "No pending migrations" then masks a stale
schema.

