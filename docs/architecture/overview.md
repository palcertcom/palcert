# PalCert architecture overview

_Status: current as of Phase 17 (complete)._

## 1. What PalCert is

PalCert is a multi-tenant SaaS platform that checks documents against an
organization's own published standard, optionally repairs safe formatting
violations, routes compliant documents for institutional approval, and issues a
verifiable certificate.

```
Define → Check → Fix → Verify → Approve → Certify
```

## 2. Non-negotiable architectural principles

| # | Principle |
| --- | --- |
| P1 | **AI is not the compliance authority.** A deterministic rule engine computes every pass/fail and the compliance score. AI never scores. |
| P2 | **AI is provider-agnostic.** All AI access goes through an `AIProvider` interface; business logic never imports a vendor SDK. |
| P3 | **Tenants are `Organization`s, not universities.** No entity, column or route may be university-specific. |
| P4 | **Published standard versions are immutable.** A historical check always resolves to the exact rules that produced it. |
| P5 | **Originals are immutable.** SmartFix always produces a new document version plus a change manifest. |
| P6 | **Money is a ledger, not a mutable balance field.** Append-only, idempotent, auditable. |
| P7 | **Blockchain-ready, blockchain-free.** v1 computes and stores SHA-256 hashes for documents, standard versions, reports and certificates; no chain integration. |
| P8 | **Arabic and English from day one**, including RTL layout. |

## 3. System shape

Modular monolith plus independent document-processing workers (§33). Not
microservices — the coupling cost is not yet justified.

```
                       ┌───────────────────────────┐
   Browser  ─────────► │  apps/web (Next.js)       │
                       │  ar/en, RTL-aware         │
                       └───────────┬───────────────┘
                                   │ HTTPS  /api/v1
                       ┌───────────▼───────────────┐
                       │  apps/api (NestJS)        │
                       │  modular monolith         │
                       │  auth · orgs · standards  │
                       │  rules · checks · billing │
                       └──┬────────┬───────────┬───┘
                          │        │           │
             ┌────────────▼──┐  ┌──▼────────┐ ┌▼──────────────┐
             │ PostgreSQL    │  │  Redis    │ │ S3-compatible │
             │ tenant data   │  │ cache +   │ │ object store  │
             │ ledger, audit │  │ queues    │ │ documents     │
             └───────────────┘  └──┬────────┘ └───────────────┘
                                   │ jobs
                       ┌───────────▼───────────────┐
                       │  workers (from Phase 5)   │
                       │  analysis · smartfix ·    │
                       │  notification             │
                       └───────────┬───────────────┘
                                   │ HTTP
                       ┌───────────▼───────────────┐
                       │ services/document-engine  │
                       │ Python — DOCX/PDF parsing │
                       └───────────┬───────────────┘
                                   │ (Phase 8)
                       ┌───────────▼───────────────┐
                       │ AI provider abstraction   │
                       │ Anthropic · OpenAI · …    │
                       └───────────────────────────┘
```

Heavy document analysis never runs inside an HTTP request (§17).

## 4. Components as of Phase 0

| Component | Technology | Phase 0 scope |
| --- | --- | --- |
| `apps/api` | NestJS 11, TypeScript | Config validation, structured logging, correlation IDs, global error handling, rate limiting, security headers, Prisma + Redis connections, health probes, OpenAPI |
| `apps/web` | Next.js 15, React 19 | Locale routing (`/en`, `/ar`), direction-aware layout, message catalogues, security headers |
| `services/document-engine` | Python 3.11, FastAPI | Service shell: settings, structlog, correlation IDs, error contract, health probes |
| `packages/contracts` | TypeScript | Error codes, `AppError`, health contract, API constants |
| `packages/config` | TypeScript, Zod | Validated environment schemas for API and web |
| `packages/database` | Prisma 6, PostgreSQL 17 | Client factory, migrations, row-level security policies, dual database identities |
| `apps/api` worker (Phase 5) | Same codebase, own process (`start:worker`) | Consumes the processing ledger: validates, hashes, scans and promotes uploads; own health probes |
| Object storage (Phase 5) | S3-compatible (MinIO locally) | Quarantine and clean buckets, versioned, encrypted, presigned access only |
| ClamAV (Phase 5) | clamd | Malware scanning over `INSTREAM`; an outage blocks, never bypasses |
| `services/document-engine` (Phase 6) | Python, FastAPI | Raw OOXML analysis: structural model, effective formatting, `DocumentFactSet`. A pure function of bytes — it holds no credentials and touches no database |

## 5. The hybrid compliance pipeline (target design)

```
Upload → extension/MIME/size validation → security scan → secure storage
      → SHA-256 → parser → normalized document model
      → deterministic checks ──┐
                               ├─► findings → Compliance Engine → machine report
      → AI semantic checks ────┘                                      │
                                                                      ▼
                                                       AI explanation layer (prose only)
```

The **machine report** holds authoritative values (rule, expected, actual,
location, result, severity). The **AI explanation layer** may only add prose;
it can never alter a machine result (§19).

The "deterministic checks" box is the Phase 4 rule engine
([rule-engine.md](rule-engine.md)): a pure library that evaluates a normalized
fact set against a published standard and returns one of `PASS`, `FAIL`,
`NOT_APPLICABLE` or `INDETERMINATE` per rule. It never calls a model; AI-assisted
and manual rules come back explicitly unresolved for the review path.

## 6. Cross-cutting foundations established in Phase 0

- **Configuration** — one Zod schema per process, validated at boot; a
  misconfigured process exits with `EX_CONFIG` (78) rather than failing later.
  Production-only invariants are enforced in the schema (docs disabled, JSON
  logging, no wildcard CORS).
- **Logging** — pino (TS) and structlog (Python) emit JSON with `service`,
  `version`, `env` and `request_id` on every line. Credentials, cookies and
  password fields are redacted in the logger itself.
- **Correlation IDs** — `x-request-id` is accepted from the caller, generated
  when absent, echoed on every response, and propagated across services.
- **Errors** — one `AppError` type per runtime with stable codes. Clients get
  `{ error: { code, message, details?, requestId } }`; stack traces and internal
  context are logged only.
- **Health** — `/health/live` (process) and `/health/ready` (dependencies, with
  a 2s per-probe budget, probed concurrently). Probe responses never disclose
  hostnames or driver errors.

## 6a. Tenancy (Phase 2)

Every organization-owned row is protected by four independent layers: tenant
resolution, tenant authorization, explicit query scoping, and PostgreSQL
row-level security under a database role that cannot bypass it. Tenant context
is transaction-local, so it cannot survive into another request on a pooled
connection.

See [tenancy](tenancy.md) and ADR-0017 through ADR-0019.

## 6b. Documents (Phase 5)

A user's uploads are user-private, never organization-scoped. The browser
uploads straight into a quarantine bucket through a presigned PUT; the API
only authorizes and finalizes. A worker validates the bytes, hashes them,
scans them and promotes an immutable copy into the clean bucket; processing
intent is a transactional outbox row delivered over BullMQ. See
[documents](documents.md) and ADR-0031 through ADR-0038.

## 6c. Document analysis (Phase 6)

A READY DOCX becomes an immutable analysis artifact holding two layers: a rich
structural model for SmartFix and debugging, and the Phase 4 `DocumentFactSet`
the rule engine consumes. The API and worker hold the storage credentials and
the database; the Python engine holds the OOXML knowledge, and the boundary
between them carries bytes and a digest in, artifact bytes and counters out.

Analysis never reports what the file does not state: no page numbers, no
invented application defaults. See [docx-analysis](docx-analysis.md) and
ADR-0039 through ADR-0045.

## 6d. Document checks (Phase 7)

A user's READY DOCX version, checked against an organization's published
standard version, producing one immutable report. The check captures the exact
identities of both at creation and re-verifies them before evaluating; the
Python engine does the evaluating, because there is exactly one implementation
of every operator.

Processing status and compliance determination are separate fields: a check
that could not finish has no verdict, and "could not decide" is never mapped to
a failure. The score covers deterministic rules only and says so.

Checks are private to the user. The organization that published the standard
learns nothing — not the document, the check, the findings, the score, or that
a check happened. See [checks](checks.md) and ADR-0046 through ADR-0053.

## 6e. AI review (Phase 8)

A second opinion on the requirements that need reading rather than measuring,
bolted alongside the deterministic report and never into it. It runs only on a
completed check, only for `AI_ASSISTED` rules, and only after the document's
owner has agreed to external processing.

PalCert sends a bounded, normalized context bundle — an outline, the selected
paragraphs, the findings already measured — never the file, the ZIP bytes or
the whole document. Output is schema-constrained and validated against the
request: exactly the rules asked for, and only evidence PalCert supplied.

An assessment is `SATISFIED`, `NOT_SATISFIED` or `INSUFFICIENT_EVIDENCE` —
never `PASS` or `FAIL` — and it decides nothing. A blocking AI-assisted rule
still requires a person whatever the model concluded, enforced by a database
constraint. `reportHash`, `evaluationHash`, the determination, the score and
every finding row are byte-for-byte identical before and after a review. See
[the AI engine](ai-engine.md) and ADR-0054 through ADR-0060.

## 6f. Rule extraction (Phase 9)

PalCert reads an institution's own guidelines and templates and **proposes**
rules for a draft standard. An authorized person decides; nothing is published
automatically and no rule is created without explicit human acceptance.

Source documents are **organization-owned**, not user-owned, attach only to a
draft version, are immutable once uploaded, and go through the Phase 5
ingestion pipeline unchanged. A separate **organization** consent — which a
template manager cannot grant — gates the reading step and nothing else:
uploading sources and writing rules by hand never needed it.

Extraction is two provider passes, because citations and structured output
cannot be requested together. Pass A returns cited passages and PalCert keeps
only what the citation machinery attested; Pass B turns that verified evidence
into schema-constrained proposals and is given no source document at all.
Templates are measured by the Phase 6 analyzer rather than by a model, and what
a template does is reported as an observation with its counts — never as a
requirement, and never with a confidence number.

A proposal that PalCert's own rule validator refuses is shown to the reviewer
unchanged, with the reasons. Two sources that disagree are both reported and
neither is chosen. Accepting a proposal creates a rule through the same Phase 3
path a hand-written rule takes, and records provenance that is deliberately
outside the standard's content hash. See
[rule extraction](rule-extraction.md) and ADR-0061 through ADR-0067.

## 6g. Customer credit and payments (Phase 10)

A customer holds **PalCert Balance**: credit with PalCert, in an ordinary
currency. Money is an integer count of minor units with an ISO 4217 code —
`BIGINT` in the database, a string on the wire, never a float and never a JSON
number.

The balance is **not a column**. It is the sum of an append-only ledger whose
`UPDATE` and `DELETE` raise from every role; a correction is a compensating
entry, never an edit. Spending is a two-step reservation — reserve under a row
lock, then capture or release — so two concurrent requests cannot overspend one
balance.

Adding credit happens on the payment provider's own hosted page; PalCert never
sees a card number. **Credit is applied only by a signature-verified provider
event or by PalCert's own re-query of the provider** — never because a browser
returned to a success URL — and processing re-retrieves the payment rather than
trusting the payload. A reconciliation sweeper means credit still arrives if a
webhook never does.

Prices are immutable versions the server derives; the client never names a
price. Promotional credit is spendable and structurally cannot leave as cash.
Business logic imports no payment SDK: one port, one Stripe adapter, and a fake
provider the factory refuses to start with in production. Phase 10 deliberately
does not charge for document checks — that is Phase 11. See
[finance](finance.md) and ADR-0068 through ADR-0076.

## 6h. Paid document checks (Phase 11)

A document check is something a customer buys with PalCert Balance. Credit is
**reserved** when the check is created and **charged** only when the report is
successfully delivered. A technical failure or a cancellation releases the
reservation and charges nothing — which is never called a refund, because
nothing was ever taken.

All four determinations are delivered services: a `NON_COMPLIANT` report is
charged exactly as a compliant one is. The customer buys the analysis and the
report, not a pass.

Buying and starting a check is one transaction — the quote spent, the credit
reserved across as many accounts as it takes, the purchase, the check, the
retention lock and the durable processing intent — so a crash immediately
afterwards cannot strand a reservation. Completion and capture are one
transaction too, entered through the check's row lock, so there is no state in
which a check is cancelled and charged or completed and released.

A `ServicePurchase` is deliberately a reusable domain rather than three columns
on a check, and its allocations record which credit classes funded it:
promotional first, then cash, each captured into its own account. Phase 11
knows nothing about Stripe — a customer with balance can buy a check while the
payment provider is down. Billing never enters the canonical report, so every
Phase 7 report hash is unchanged. See [paid checks](paid-checks.md) and
ADR-0077 through ADR-0082.

## 6i. SmartFix (Phase 12)

Deterministic DOCX correction of the formatting failures a completed check
found. PalCert may change deterministic formatting; it may never silently
change academic meaning. A plan is free and hashed, the correction produces a
new hidden version rather than editing the original, and the manifest is
computed from the output rather than asserted from the intent. See
[SmartFix](smartfix.md) and ADR-0083 through ADR-0091.

## 6j. PDF inspection (Phase 13)

A second way of producing facts, not a second way of checking them: a PDF is
parsed in a bounded child process into the same `DocumentFactSet` the DOCX
analyzer produces, and everything downstream is Phase 6 and Phase 7 machinery
unchanged. PDF is an inspection format, not a SmartFix format, and a standard
with zero PDF coverage is refused rather than sold. See
[PDF analysis](pdf-analysis.md) and ADR-0092 through ADR-0103.

## 6k. Official submissions (Phase 14)

A private check is not a submission. Submitting copies the exact bytes and the
exact report into an immutable snapshot, and that snapshot is the handoff —
nothing later reads through to the private document. `DUAL_PARTY_SCOPED`
isolation lets the submitter and the receiving organization each read the
submission without either being able to rewrite it, and PalCert's technical
determination stays a separate vocabulary from the institution's decision. See
[official submissions](official-submissions.md) and ADR-0104 through ADR-0110.

## 6l. Certificates (Phase 15)

A certificate exists only where a PalCert determination of `COMPLIANT` and an
institution decision of `APPROVED` both hold for the same immutable submission
revision. Issuance is scheduled inside the decision transaction; the row holds
no verification capability, because the code is sealed with a key PostgreSQL
never has; and revocation changes validity only, so an old QR code still
answers and says `REVOKED`. See [certificates](certificates.md) and ADR-0111
through ADR-0115.

## 6m. Notifications (Phase 16)

A notification reports an authoritative event and never becomes one. Nine event
types and two channels, with `domain_events` as an append-only producer-level
idempotency root and `ProcessingJob` still the one dispatch mechanism.
Authority is resolved at delivery rather than at fan-out, and workflow mail is
configured separately from authentication mail so it can never carry a
credential. See [notifications](notifications.md) and ADR-0116 through
ADR-0119.

## 6n. Outbound webhooks (Phase 17)

An external projection of an authoritative `DomainEvent`, never an authority
itself. A committed, webhook-eligible event fans out to an organization's
ACTIVE, subscribed endpoints as durable deliveries, each signed with
HMAC-SHA256 over the exact bytes sent and dispatched through a narrow HTTP
client that re-resolves DNS, classifies every answer against committed IANA
registries and connects to the address it checked. URLs and signing secrets are
sealed with a key-id keyring, and configuration becomes live only through a
verification attempt that actually succeeded.

Retries are two separate ladders, and keeping them separate is the load-bearing
part of the design. The queue's ladder is short and answers "did this process
manage to run the attempt?" — interruption, a lost lease, a database that went
away. The webhook ladder is long (1m, 5m, 30m, 2h, 12h, 24h, then done) and
answers "is the receiver ready yet?". So a receiver's answer — a 503, a 429, a
connect timeout — never throws: the attempt is recorded, the delivery carries
its own `nextAttemptAt`, the job succeeds, and a sweeper re-arms that same job
when the time comes. A `WEBHOOK_DELIVER` job is the only kind the processing-job
lifecycle lets move back from SUCCEEDED to PENDING, and only to PENDING, which
is what makes the business ladder possible without giving any other job type a
way to run twice.

Two invariants hold that separation up. A delivery that is `FAILED_RETRYABLE`
always carries the time it is waiting for — the schema refuses a row that does
not — and a worker that finds one whose time has not arrived makes no request,
opens no attempt and changes nothing, so an early queue redelivery after a crash
cannot become an early request to a receiver that just asked for time. And a
delivery a dead worker left `SENDING` is recovered on the first reclaim rather
than after the queue has spent its whole attempt budget: the reclaiming worker
holds the lease, so the previous one is already gone.

An attempt is one write at each end. Beginning one moves the delivery to
`SENDING`, counts the attempt and inserts the attempt row in a single doorway,
so `attempt_count` equals the number of attempt rows by construction. That
matters because the counter indexes the retry ladder: while starting was two
commits, a crash between them spent a rung with no attempt row and no request,
and the recovery then spent another putting it right — a few restarts could
exhaust an organization's webhook retries without a single request leaving the
process. The rung is now the attempt's own number.

The database enforces both ends of that, not the service. Beginning refuses a
delivery whose own `next_attempt_at` has not arrived, comparing against the
worker's clock rather than the database's, so no code path can start a real
attempt ahead of the business schedule. And the parent-only transition accepts a
closed set of shapes, every one of them something knowable with no socket open —
a skip, a configuration that stopped describing itself, a URL the policy no
longer allows, a worker that died. It cannot write an HTTP status at all, and it
refuses receiver-derived codes, so there is exactly one authority for what a
receiver said.

An attempt and what it decided are one write. Closing the attempt row and moving
the delivery used to be two commits, and the gap between them was a crash window
with a nasty property: the receiver's answer was already durable and the parent
did not know it, so a reclaiming worker read an interrupted send and asked again.
One doorway now does both, the database refuses to record a receiver's answer on
an attempt any other way, and a partial unique index allows only one open attempt
per delivery. What is left is the boundary anyone would want — if the write
commits and the process then dies, the reclaim reads a finished delivery and
sends nothing; if it never commits, the attempt is still open and the ambiguous
send is retried, knowingly, at least once.

Verification is deliberately not a delivery. Its wire identity is the
verification attempt — the attempt's id is the delivery header and the id the
signature commits to — so two handshakes against one configuration are never
byte-identical, and a refusal that never reached the wire opens no attempt at
all. A receiver's HTTP answer, retryable or not, settles the administrator's
intent instead of requeueing the job; asking again is an explicit act with a new
idempotency key, and that settlement is atomic with recording the answer for the
same reason. Only a transport failure, where nothing was heard at all, leaves the
intent open for the same job to try again — and an attempt a dead worker left
open is closed on the first reclaim, so the retry carries a new attempt id and a
new challenge. See [webhooks](webhooks.md).

## 7. What Phase 0 deliberately does not do

No authentication, organizations, standards, rules, document parsing, AI,
billing, submissions, certificates or notifications. Each arrives in its own
phase with its own migrations, tests and documentation.

## 8. Related documents

- [Architecture decision records](../adr/README.md)
- [Standards, versions and rules](standards.md)
- [The deterministic rule engine](rule-engine.md)
- [Secure document upload, storage and processing](documents.md)
- [DOCX document analysis](docx-analysis.md)
- [Document checks, results and reports](checks.md)
- [The AI engine](ai-engine.md)
- [Rule extraction from guidelines and templates](rule-extraction.md)
- [Customer credit, payments and the ledger](finance.md)
- [Paid document checks](paid-checks.md)
- [PDF document analysis](pdf-analysis.md)
- [SmartFix document correction](smartfix.md)
- [Official submissions and institutional review](official-submissions.md)
- [Certificates and public verification](certificates.md)
- [Notifications and reliable event delivery](notifications.md)
- [Organization integrations and outbound webhooks](webhooks.md)
- [The integration API and machine credentials](integration-api.md)
- [Phase 19 capability matrix](phase-19-capability-matrix.md)
- [Phase 20 Checkpoint 1 — production readiness audit](../operations/phase-20-checkpoint-1-production-readiness-audit.md)
- [Deploying PalCert](../operations/deployment.md)
- [Phase 20 Checkpoint 2 — runtime and deployment report](../operations/phase-20-checkpoint-2-runtime-and-deployment-report.md)
- [Observability](../operations/observability.md)
- [Alerting](../operations/alerting.md)
- [Dashboard specification](../operations/dashboards.md)
- [Phase 20 Checkpoint 3 — observability and alerting report](../operations/phase-20-checkpoint-3-observability-and-alerting-report.md)
- [Citations and references](citations.md)
- [Coding standards](coding-standards.md)
- [Development setup](development-setup.md)
- [Security baseline](../security/baseline.md)
- [API conventions](../api/conventions.md)
