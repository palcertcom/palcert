# PalCert development phases

Each phase ends with tests passing, documentation updated, a completion report
and an explicit approval gate. Phases are not skipped without approval (§42).

| Phase | Title | Status |
| --- | --- | --- |
| 0 | Product and engineering foundation | ✅ Complete |
| 1 | Authentication and RBAC | ✅ Complete |
| 2 | Organization management and tenant isolation | ✅ Complete |
| 3 | Document types, standards, versioning and the rule builder | ✅ Complete |
| 4 | Deterministic rule engine and evaluation architecture | ✅ Complete |
| 5 | Secure document upload and storage | ✅ Complete |
| 6 | DOCX document engine | ✅ Complete |
| 7 | Deterministic compliance engine and reports | ✅ Complete |
| 8 | AI engine | ✅ Complete |
| 9 | AI-assisted rule extraction | ✅ Complete |
| 10 | Customer balance and payments | ✅ Complete |
| 11 | Paid PalCert Check workflow | ✅ Complete |
| 12 | SmartFix | ✅ Complete |
| 13 | PDF inspection | ✅ Complete |
| 14 | Private checks and official submission | ✅ Complete |
| 15 | Certificates and verification | ✅ Complete |
| 16 | Notifications | ✅ Complete |
| 17 | Organization integrations and secure outbound webhooks | ✅ Complete |
| 18 | References and citation engine | ✅ Complete |
| 19 | Public integration API, API clients and machine authentication | ✅ Complete |
| 20 | Production readiness, operations and final v1 release | ✅ Complete |

**PalCert v1 is released** as `0.1.0+4554c7a` (commit
`4554c7a2f88c148e16e4e2f93801d1c9df1e0df6`, tag `v0.1.0`). The development
roadmap is complete: every phase above is delivered, and there is no further
mandatory v1 phase. See the
[final production readiness report](../operations/phase-20-checkpoint-9-final-release-candidate-report.md).

### Post-v1 backlog

Everything deferred during Phases 18–20 is in the
[v1 known-limitations register](../operations/v1-known-limitations.md), with
its status, why it is not a blocker, and any owner decision it waits on:

- operational: P-004 distributed tracing, P-011 point-in-time recovery, P-012
  backup replication, P-013 scheduled restore drills, P-001 partitioning, P-006
  a status page, P-007 worker autoscaling, P-008 per-route objectives, P-009
  re-derived alert thresholds, R-9 a formatter exception so release records
  can be committed;
- security hardening: P-015 a nonce or hash `script-src`, P-002 RLS on the
  authentication tables, P-016 web-server environment validation, F-020 a
  licence scan in CI;
- capacity: P-014 worker memory under its own workload (inconclusive);
- deployment: P-003 multi-region, P-017 a browser upload origin other than the
  web origin, P-018 an explicit SSE header on restore writes;
- product: the citation roadmap beyond Phase 18 (named style conformance, CSL,
  style conversion, bibliography rewriting, SmartFix citation correction),
  Q-005 a localized 404 body without JavaScript, and the scientific journal
  enhancements below.

These are candidates for future roadmap phases, not v1 work.

### Deferred roadmap items

**Scientific journal enhancements** was the working title of Phase 17 in an
earlier plan. The approved Phase 17 is the webhook work above, and the journal
scope has not been cancelled — it is deferred, with no phase number, pending
roadmap approval. It is recorded here rather than quietly renumbered into
Phase 18, 19 or 20, because those three have their own approved scopes and
absorbing a fourth into one of them would misrepresent all of them.

## Phase 0 scope (delivered)

Repository structure, architecture documentation, ADRs, environment
configuration, Docker development setup, database setup and migration pipeline,
CI, linting, formatting, testing frameworks, structured logging, error-handling
conventions, configuration validation and health checks.

Explicitly **not** in Phase 0: any business functionality.

## Phase 1 scope (delivered)

Registration, email verification, login, logout, password reset and change,
opaque server-side sessions with revocation and listing, RBAC with
permission-based authorization, TOTP multi-factor authentication with recovery
codes, account status controls, security events, an append-only audit log, the
administrator bootstrap command, and the bilingual authentication UI.

Explicitly **not** in Phase 1: organizations and organization-scoped role
grants (Phase 2), API-client credentials, SSO/SAML, and the notification
transport (Phase 16 — Phase 1 ships the `MailDeliveryPort` boundary only).

## Phase 2 scope (delivered)

Organizations as the tenant primitive, membership with an explicit lifecycle,
organization-scoped RBAC, invitations, identity verification, ownership transfer
with a last-owner invariant, organization and membership suspension, the
organization dashboard with a switcher, and four-layer tenant isolation
culminating in PostgreSQL row-level security under a least-privileged database
role.

Also resolved: the Phase 1 deferred `user_roles.organization_id` foreign key, and
the Phase 1 pagination-convention debt.

Explicitly **not** in Phase 2: document types, standards, rules, uploads,
payments and SmartFix (their own phases); a public organization directory
(deferred, see below); organization slug renaming (deferred with a documented
reason in ADR-0020's sibling, `slug.service.ts`).

## Phase 3 scope (delivered)

Document types (a closed PalCert category plus an organization-chosen name),
standards as a stable identity, standard versions with a
`DRAFT → PUBLISHED → ARCHIVED` lifecycle, and the declarative rule model — 23
categories, 14 operators, a discriminated scope and expected value, units,
tolerance, severity, blocking, autofix and provenance, with bilingual text
throughout.

Publication computes a SHA-256 content hash over a canonical semantic snapshot
and freezes the version at both the application and the database layer. Changing
a published standard is clone → edit → publish. Optimistic concurrency is
`If-Match` on the version's revision, one strategy everywhere.

The rule builder composes `scope` and `expected` from typed, conditional
controls driven by the server's own compatibility matrix — no raw-JSON editing
as the normal path — with reordering by button and arrow key, not drag alone.

Architecture decisions: [ADR-0022](../adr/0022-rules-are-data-not-code.md),
[ADR-0023](../adr/0023-standard-content-hashing.md),
[ADR-0024](../adr/0024-published-immutability.md),
[ADR-0025](../adr/0025-optimistic-concurrency-for-drafts.md). Reference:
[standards.md](../architecture/standards.md).

Explicitly **not** in Phase 3: any AI call, DOCX or PDF parsing, compliance
evaluation, SmartFix, and any executable rule DSL. This phase defines what a
document will be checked against; checking it begins in Phase 6.

## Phase 4 scope (delivered)

A deterministic, reproducible, typed rule engine that evaluates Phase 3 rules
against a **normalized fact set** — synthetic in this phase; produced by the
parsers of Phase 6 and Phase 13 later. One JSON Schema defines the fact set,
the evaluation request and the result for both TypeScript and Python; types
are generated from it, both runtimes validate against it, and shared
accept/reject fixtures fail CI on whichever side drifts.

Measurements use exact rational arithmetic with decimal strings on the wire —
binary floating point never touches a comparison. Units carry dimensions, so a
pixel never converts to a length. Every rule yields one of four outcomes
(`PASS`, `FAIL`, `NOT_APPLICABLE`, `INDETERMINATE`) with a stable reason code;
missing evidence is never `PASS`, an engine error is never `FAIL`, and coverage
defaults to `UNAVAILABLE` so a silent extractor cannot certify anything.
Results are canonical, machine-readable evidence with exact counts and capped
returned violations.

The Phase 3 blocking invariant was amended as **Rule Schema v2**: a rule may be
blocking in any evaluation mode, and an unresolved non-deterministic blocking
rule holds the compliance decision open. Version 1 stays valid under its own
rules; nothing published was rewritten and the v1 golden hash is proven
unchanged. Upgrading is an explicit, audited clone option.

Architecture decisions: [ADR-0026](../adr/0026-normalized-fact-model.md),
[ADR-0027](../adr/0027-exact-decimal-arithmetic.md),
[ADR-0028](../adr/0028-evaluation-result-semantics.md),
[ADR-0029](../adr/0029-cross-language-contract-source-of-truth.md),
[ADR-0030](../adr/0030-rule-schema-v2-blocking-semantics.md). Reference:
[rule-engine.md](../architecture/rule-engine.md).

Explicitly **not** in Phase 4: DOCX or PDF parsing, document upload, any AI
provider call, the final compliance score, persisted checks or reports, any
public evaluation API, any user-supplied regular expression or executable
expression. The engine is a pure library exercised by tests.

## Phase 5 scope (delivered)

The first real input path: a user's own DOCX or PDF, taken in safely and
turned into an immutable, hashed, scanned, downloadable **document version**.

```
Upload → Quarantine → Validate → Malware scan → Hash → Secure storage → Ready
```

Documents are **user-private** — owned by a user, fenced by row-level security
on `owner_user_id`, never visible to an organization; official submission is a
later, explicit act. Uploads go straight from the browser to a **quarantine
bucket** through a presigned PUT that binds size and type; the API never
touches file bytes. `finalize` captures the exact **object version** so a
reused URL can never change what gets processed. A separate worker process
validates from the bytes (magic numbers, PDF structure, DOCX package safety
without extraction: entry limits, ratio, traversal, macros, embedded objects,
external content), hashes with SHA-256 into a private temp file, scans with
ClamAV over `INSTREAM`, and promotes a server-side copy into the **clean
bucket**. A scanner error is never a pass; a content rejection is final; an
infrastructure failure is retried and then retryable by the owner.

Processing intent is a **transactional outbox** row published to BullMQ on the
existing Redis; the ledger owns claims, leases, heartbeats, retries, backoff
and dead jobs, so duplicate or lost deliveries lose nothing. Versions are
immutable and never overwritten; deletion is soft with an asynchronous purge
that respects retention locks. The web app uploads with progress, shows
processing stages, lists versions and downloads through short-lived signed
URLs, in English and Arabic, without naming any internal component.

Operational debt from Phase 4 was closed: the health e2e suite is hermetic,
the Python `egg-info` directory left version control, and `pip-audit --strict`
audits the frozen dependency closure instead of the editable project.

Architecture decisions: [ADR-0031](../adr/0031-user-private-document-ownership.md)
through [ADR-0038](../adr/0038-document-version-immutability.md). Reference:
[documents.md](../architecture/documents.md).

Explicitly **not** in Phase 5: DOCX or PDF formatting extraction, rule
evaluation against uploads, AI analysis, compliance scoring, reports,
SmartFix, payments, official submission.

## Phase 6 scope (delivered)

PalCert's production DOCX analysis engine: a READY DOCX version becomes a
normalized structural model, effective formatting, and a Phase 4
`DocumentFactSet`, stored as one immutable artifact.

The analyzer reads **raw OOXML** rather than delegating to a high-level
library, because effective formatting needs `docDefaults`, style inheritance,
toggle semantics, theme fonts, numbering, sections and the complex-script
channel — all of which a convenience API hides. XML parsing is hardened:
every DOCTYPE is refused, so XXE and entity expansion have no entry, and
depth, element count and byte budgets are enforced while parsing. Parts are
resolved through OPC relationships, both OOXML profiles are supported, and an
external relationship is never fetched.

Typography is resolved **per script**: a run holding Arabic and English yields
two fonts and two sizes, because OOXML routes them through different slots.
Headings come from outline level, never from boldness or a localized style
name. Line spacing keeps its AUTO/EXACT/AT_LEAST semantics. Every measurement
converts with exact rational arithmetic.

PalCert **never invents what the file does not say**. No fact carries a page
number, `PAGE` coverage is UNAVAILABLE, a saved page count is recorded as an
application hint, and a property absent from direct formatting, the style
chain, `docDefaults` and the theme stays unresolved rather than becoming
Word's fallback.

A `DocumentAnalysis` is immutable and reusable: `ensureDocxAnalysis` returns a
compatible analysis or creates one, a new analyzer version produces a new row,
and artifacts live in a third private bucket no browser can reach. Analysis
runs on demand through Phase 5's existing outbox, ledger and retry policy.

**Fact Schema v2** was introduced deliberately: v1 has no `ENDNOTE` or
`TEXTBOX` element type, and filing note or text-box content under `PARAGRAPH`
would let a body-text rule fail because of a footnote. v1 stays valid for ever,
Phase 4's goldens are unchanged, and both validators enforce the version's
vocabulary.

Architecture decisions: [ADR-0039](../adr/0039-raw-ooxml-parsing.md) through
[ADR-0045](../adr/0045-tracked-changes-final-view.md). Reference:
[docx-analysis.md](../architecture/docx-analysis.md).

Explicitly **not** in Phase 6: standard selection, rule evaluation, compliance
scoring, reports, AI calls, SmartFix, DOCX modification, PDF analysis,
payments.

## Phase 7 scope (delivered)

The first end-to-end PalCert workflow. A user picks one of their READY DOCX
versions and a published standard from a public catalogue; PalCert analyses the
document (reusing an existing analysis when there is one), evaluates the
standard's rules deterministically, and produces one immutable report.

A check **captures exact identities** at creation — the document version and its
digest, the standard version and its content hash, the analysis and its
artifact digest — and a trigger refuses to change them. Every one is
re-verified before evaluation, and a mismatch fails the check closed rather
than evaluating something the check never promised.

**Processing status and compliance determination are separate fields.** A check
that failed has no determination at all: an engine outage must never read as
"your thesis does not comply". `INDETERMINATE` means the evidence could not
decide and is never mapped to a failure.

The **deterministic score** counts deterministic rules only, once each,
weighted by severity, computed in exact integer arithmetic and rendered as a
decimal string. It is `null` — not zero — when nothing scorable resolved, it
reports its own coverage when rules were left unresolved, and the product says
plainly that it decides nothing about approval, publication or certification.

The **report** is immutable, language-neutral, validated against a shared JSON
Schema, canonicalized by RFC 8785 and hashed twice: once for the record, once
for the conclusion independently of which check produced it. A committed golden
fixture is verified in CI, so a canonicalization change cannot happen by
accident.

Checks, runs, results, violations and reports are **USER_SCOPED**. The
organization that published the standard sees nothing: not the document, not
the check, not the findings, not the score, not even that a check happened. The
catalogue that makes its standard findable is served by narrow `SECURITY
DEFINER` functions rather than by loosening any tenant policy, and exposure is
opt-in, permissioned and audited.

There is **exactly one rule evaluator**, the Python one, now reachable over a
narrow HTTP boundary carrying a fact set and published rules in, results out.

Architecture decisions: [ADR-0046](../adr/0046-check-binds-exact-identities.md)
through [ADR-0053](../adr/0053-bounded-violation-storage.md). Reference:
[checks.md](../architecture/checks.md).

Explicitly **not** in Phase 7: Claude, OpenAI, Gemini or any AI verdict;
SmartFix; payments; PDF analysis; institutional submission; university
approval; certificates.

## Phase 8 scope (delivered)

The AI engine. A completed check can be given a **second opinion** on the
requirements that need reading rather than measuring — and on nothing else.

**The deterministic report is not touched.** No Phase 8 code path writes to a
Phase 7 table; `reportHash`, `evaluationHash`, the determination, the score,
every `CheckRuleResult` and every `CheckViolation` are byte-for-byte identical
before and after a review, asserted in e2e.

AI work leaves the application only through `AIProviderPort`. The real
implementation is `AnthropicAIProvider`; a deterministic `FakeAIProvider` serves
tests and is **refused in production**. There is no fallback to a second
company: if the configured provider fails, the review fails and says so.

**Nothing leaves PalCert without consent.** Consent is per user, versioned, and
states plainly what is sent, that processing happens at an external provider,
and that retention is governed by PalCert's agreement with them. An
organization cannot grant it, and never sees the resulting review.

PalCert sends a bounded **context bundle** — outline, selected paragraphs,
metadata, the findings already measured — never the file, the ZIP bytes or the
whole document. When a bound bites, the truncation is stated to the model with
an instruction to answer `INSUFFICIENT_EVIDENCE` rather than infer.

Prompts are **constants in a registry**, versioned and hashed; document text and
organization guidance are escaped and confined to data sections of the user
message. Calls declare **no tools**, no `temperature`/`top_p`/`top_k`, and no
prefill. Output is schema-constrained and then validated against the request:
exactly the requested rules, once each, citing only nodes PalCert supplied.

An assessment is `SATISFIED`, `NOT_SATISFIED` or `INSUFFICIENT_EVIDENCE` — never
`PASS`/`FAIL`, and never a confidence number. A **blocking** AI-assisted rule
records `requiresHumanReview = true` regardless of what the model concluded,
computed from the rule and enforced by a database CHECK constraint. Manual rules
are never sent to a model at all.

Completed reviews are **append-only** and hashed on their own canonical digest;
the AI hash is never mixed with the Phase 7 report hash. A re-run produces a new
review rather than overwriting one someone may have read.

AI tables are **USER_SCOPED** under `FORCE ROW LEVEL SECURITY`. Provider
unavailability degrades the AI feature only: `/health/ready` deliberately does
not probe the provider.

Architecture decisions: [ADR-0054](../adr/0054-ai-provider-behind-a-port.md)
through [ADR-0060](../adr/0060-ai-reviews-are-immutable-and-hashed.md).
Reference: [ai-engine.md](../architecture/ai-engine.md).

Explicitly **not** in Phase 8: AI rule extraction from guideline files (Phase
9); automatic Standard creation from AI; SmartFix; payments; PDF analysis;
institutional approval; certificates; blockchain; OJS integration; provider
fallback to another company; any general-purpose "ask the model" endpoint.

## Phase 9 scope (delivered)

AI-assisted guideline and template rule extraction. PalCert reads an
institution's own documents and **proposes** rules for a draft standard.

**AI proposes. An authorized human decides.** No code path turns a completed
extraction into a published standard, none creates a `StandardRule` except the
Phase 3 `insertRule` the accept endpoint calls, and both are asserted in e2e.

Source documents (`GUIDELINE_PDF`, `GUIDELINE_DOCX`, `TEMPLATE_DOCX`) are
**organization-scoped**, not user-scoped: a guideline is institutional policy
and outlives its uploader. They attach only to a **draft** version, are
immutable once uploaded, and go through the **same** Phase 5 ingestion pipeline
— no lighter path for organization uploads.

A separate **organization** AI consent gates extraction. `TEMPLATE_MANAGER`
deliberately cannot grant it: doing the work does not carry the authority to
commit the institution to external processing. Without it, upload and the
manual Rule Builder still work in full.

Extraction runs as **two passes**, because the provider cannot return citations
and structured output in one request. Pass A discovers evidence with citations
on and structured output off; PalCert keeps only what the citation machinery
attested and discards the model's prose. Pass B turns verified evidence into
schema-constrained proposals with citations off and **no source document**.
A DOCX is sent as one text block per PalCert node so a block citation maps to
an exact node id; raw OOXML is never sent, and a `.docx` is never sent as a PDF.

Templates are measured by the Phase 6 analyzer, never by a model. An
observation reports the modal value with its counts and a four-value uniformity
classification. **No confidence number, score or percentage is produced
anywhere.** A property with fewer than three occurrences says nothing.

Five proposal kinds; three of them carry no rule by design and a database CHECK
enforces it: an ambiguous requirement is not resolved to a plausible value, a
conflict between two sources is reported with neither chosen, and a real
requirement the schema cannot express is reported rather than forced into an
unrelated property.

Every proposed rule is validated by the Phase 3 validator at the draft's own
schema version — **AI gets no bypass**. A refused proposal is shown unchanged
with its issues. No AI-generated regex, SQL, XPath or expression of any kind
exists anywhere: rules remain data.

Accepting creates a rule through the ordinary path with the ordinary
validation, under `If-Match` on the draft revision, and records provenance that
is **excluded from the standard's content hash**. An unaccepted proposal never
affects `contentHash`. A source an accepted rule cites is retention-locked.

Reviewer feedback stays inside PalCert: nothing is sent back to the provider,
and no model is trained on it.

All eleven Phase 9 tables are `TENANT_SCOPED` under `FORCE ROW LEVEL SECURITY`
with composite tenancy keys; the isolation suite attacks with real identifiers
belonging to another organization and expects 404, never 403.

Architecture decisions:
[ADR-0061](../adr/0061-standard-sources-are-organization-owned.md) through
[ADR-0067](../adr/0067-rule-provenance-is-preserved-and-outside-the-content-hash.md).
Reference: [rule-extraction.md](../architecture/rule-extraction.md).

Explicitly **not** in Phase 9: payments or PalCert Balance (Phase 10); SmartFix
or document correction; PDF compliance checking; institution submission,
approval or certification; blockchain; OJS integration; automatic publication of
a standard; any general-purpose "ask the model" endpoint.

## Phase 10 scope (delivered)

Customer credit balance, payments, pricing, ledger, holds and the refund
foundation. A customer holds **PalCert Balance** — credit with PalCert in an
ordinary currency. It is not a wallet and has nothing to do with crypto.

**Money is an integer count of minor units** plus an ISO 4217 code: `BIGINT` in
PostgreSQL, `bigint` in TypeScript, a **string** in JSON. No float, no
`Decimal`, no JSON number, and no division by 100 anywhere — a unit test greps
the money module for `/100`, `Math.`, `parseFloat`, `toFixed` and `Number(`.
One canonical currency registry knows the exponents; USD/EUR/ILS have two
places, JOD three, JPY none.

**The balance is not a column.** It is the sum of an append-only
`CreditLedgerEntry` history. `UPDATE` and `DELETE` raise from every role,
including the schema owner, and the application role's grants for them are
explicitly revoked. Corrections are compensating entries with a reason code and
an author. A verification endpoint replays the ledger independently and checks
four invariant families.

**Spending is a reservation.** A `CreditHold` is created under
`SELECT … FOR UPDATE` on the account row, so with a $5 balance two concurrent
$4 requests cannot both succeed — proven with 2-way and 10-way races. Capture
appends the debit; release returns nothing to reverse; expiry is swept.

**Prices are immutable versions.** Once `ACTIVE` a `PriceVersion`'s financial
fields cannot change; a partial unique index permits exactly one active price
per (product, currency, market). The client never supplies an amount: it names
a product and the server answers, freezing it in a short-lived `PriceQuote`.
Phase 10 performs **no currency conversion**.

**The webhook is the payment authority; the browser redirect is not.** Credit
is applied only by a signature-verified provider event — verified against the
exact raw bytes, with browser CSRF logic deliberately not applied — or by
PalCert's own re-query. Processing ignores the payload's amount, re-retrieves
the payment, and compares amount, currency and client reference before
crediting; a mismatch parks the top-up in `RECONCILIATION_REQUIRED` and credits
nothing. The golden journey asserts the balance is still zero after the
redirect. A reconciliation sweeper means credit arrives even if no webhook ever
does.

**PalCert never sees a card.** Payment details are collected on the provider's
hosted page; no field exists for a card number, CVC, expiry or bank credential.
Signature headers, webhook secrets and raw payloads are never logged.

**Promotional credit can never become cash.** An external refund reserves
against a `CASH` account and a database CHECK refuses a `PAYMENT_REFUND_DEBIT`
on any other class. Spending draws promotional credit first. A service refund
(credit back to the balance) and an external refund (money back to a card) are
separate mechanisms with separate entry types, and only finance can start the
latter. A chargeback may take a balance below zero and PalCert does not
fabricate credit to hide it.

**Business logic imports no payment SDK.** One `PaymentProviderPort`, one
Stripe adapter that is the only file containing a Stripe event name, and a fake
provider that the factory refuses to start with in production. A provider
outage does not fail `/health/ready`; it is reported by `/health/payments`, and
the UI says only that *adding* credit is unavailable.

**Organizations have zero financial access** — no balance, top-up, payment,
ledger, refund or provider metadata — asserted by route tests and by a SQL
query proving no organization-scoped role holds any `finance:`, `pricing:` or
`balance:` permission. `PALCERT_SUPPORT` gets payment visibility and no
financial mutation permission at all.

Architecture decisions:
[ADR-0068](../adr/0068-integer-minor-unit-money.md) through
[ADR-0076](../adr/0076-provider-events-are-at-least-once-and-unordered.md).
Reference: [finance.md](../architecture/finance.md).

Explicitly **not** in Phase 10: paid document checks — `POST /checks` still
requires no funds and creates no hold (Phase 11); SmartFix; institution revenue
share, organization payouts or marketplace splitting; recurring subscription
billing; FX conversion; tax calculation; blockchain or crypto of any kind.

## Phase 11 scope (delivered)

The paid PalCert check workflow. A document check is something a customer buys
with PalCert Balance.

**A check is charged for the successful delivery of its technical report** —
not for starting it, and not for producing a particular compliance outcome.
`COMPLIANT`, `NON_COMPLIANT`, `REVIEW_REQUIRED` and `INDETERMINATE` are all
delivered services and all charged; refunding because a document failed would
mean PalCert only charges for good news.

**Credit is reserved, then captured.** A technical failure, a cancellation or
an expired reservation **releases** it and charges nothing. That is never
described as a refund, in either language: nothing was taken, and محجوز / تم
الخصم / أُلغي الحجز / أُعيد المبلغ stay four different things.

**`POST /checks` requires a server-authored price quote.** The client names a
quote; it never states an amount and there is no field for one. A quote funds
at most one purchase, is not repriced when the price changes, and is refused
once expired.

**Buying and starting a check is one transaction**: the quote spent, credit
reserved across as many accounts as it takes, the `ServicePurchase`, its
allocations, the `DocumentCheck`, the retention lock, and a durable
`CHECK_PREPARE` intent in the Phase 5 outbox. Ids are preallocated so nothing
is rebound after the commit. An insufficient balance leaves nothing at all —
no check, no purchase, no hold, no job — and the quote is still spendable.

**Completion and capture are one transaction**, entered through the check's row
lock, which every settlement path takes first. There is no state in which a
check is cancelled and charged, completed and released, or partially captured.
Deferred constraint triggers enforce the cross-domain invariants at COMMIT.

**Funding is promotional-first.** A $5 check against $2 promotional and $10
cash reserves $2 and $3 and captures each into its own account, so a later
refund returns each class to where it came from. One purchase to the customer,
two ledger entries to the accountant.

**No new check can be created without a purchase**, enforced by a trigger on
INSERT that requires the binding to name that very check — attempted in the
suite with the schema-owning connection and refused. Historical free checks are
untouched and stay readable for ever, with `billing: null` and
`legacyFree: true`.

**Phase 11 knows nothing about Stripe.** A check spends PalCert Balance only,
so a customer with credit buys one while the payment provider is down, and no
paid-check path may even ask the provider. All document-check revenue is
PalCert's: no revenue share, no payout, no organization visibility of a
student's money.

**Billing never enters the canonical report.** `reportHash` and
`evaluationHash` for identical evidence are byte-for-byte what they were, the
Phase 7 golden fixtures pass unchanged, and the canonicalization version is not
bumped.

A paid check that failed is not retried in place: no charge was made, and
running it again is a new quote, a new purchase and a new check, which keeps
the failed attempt's billing history exactly as it happened.

Architecture decisions:
[ADR-0077](../adr/0077-service-purchase-domain.md) through
[ADR-0082](../adr/0082-billing-stays-out-of-the-report.md).
Reference: [paid-checks.md](../architecture/paid-checks.md).

Explicitly **not** in Phase 11: SmartFix (Phase 12); a direct payment-provider
charge per check; institution revenue share or payouts; recurring subscriptions;
tax calculation; discount codes; FX conversion; PDF analysis; certificates;
blockchain.

## Phase 12 scope (delivered)

SmartFix: deterministic DOCX correction of the formatting failures a completed
check found.

**PalCert may change deterministic document formatting, but it must never
silently change academic meaning.** Everything in the phase is a mechanism for
keeping that true when the code is wrong, the worker dies, the engine is
upgraded, or the document changes between planning and paying.

**The original is never modified.** A correction produces a new, hidden
document version; the version the user uploaded stays exactly as it was, and
the check that found the problems keeps pointing at it.

**A plan is free, hashed, and executed as approved.** The user sees rule by
rule what would change and what would not, before any money moves. What is
executed is the plan they read, identified by its hash — not a fresh plan
computed later against a document that may have moved on.

**The capability registry is the floor.** A rule is correctable only if a
registered capability says so; an operator with more than one target, or a
script channel outside its capability, is not a correction PalCert will
attempt. The manifest is computed from the output rather than asserted from
the intent, so what is reported as changed is what actually changed.

**The recheck is an ordinary check with a purpose.** It runs the same engine
over the corrected version and produces the same kind of immutable report, and
the customer is charged once the corrected result is proved — not for the
attempt.

Architecture decisions: [ADR-0083](../adr/0083-smartfix-corrects-a-copy.md)
through [ADR-0091](../adr/0091-numeric-targets-are-round-tripped.md).
Reference: [smartfix.md](../architecture/smartfix.md).

Explicitly **not** in Phase 12: correcting PDFs (Phase 13 makes PDF an
inspection format, not a SmartFix format); rewriting prose, citations or
references; AI-authored document edits; changing an existing version in place.

## Phase 13 scope (delivered)

PDF inspection: a second way of producing facts, not a second way of checking
them.

**Everything from the fact set onwards is Phase 6 machinery, unchanged.** A PDF
is parsed into a structural model and then into the same `DocumentFactSet` the
DOCX analyzer produces, so the deterministic rule engine, the report and the
paid check workflow are untouched.

**A DOCX records instructions; a PDF records results.** The two analyzers share
an envelope, a fact schema and an orchestration, and almost nothing else,
because the formats state almost entirely different things. An observed inset
is not a margin, and the document says so rather than pretending otherwise.

**Analysis runs in a bounded child process**, after the source bytes are
verified against their stored SHA-256 and before any parser sees them. Active
content is counted, never executed.

**A zero-coverage standard is refused, not sold.** If no rule in a standard can
be evaluated against a PDF, the purchase is refused rather than charged for a
report that could say nothing. Signature and PDF/A claims are reported as the
file's own statements, never as PalCert verdicts.

Architecture decisions:
[ADR-0092](../adr/0092-pdf-is-an-inspection-format-not-a-smartfix-format.md)
through [ADR-0103](../adr/0103-active-content-is-counted-never-executed.md).
Reference: [pdf-analysis.md](../architecture/pdf-analysis.md).

Explicitly **not** in Phase 13: OCR; PDF correction or SmartFix for PDF;
validating a digital signature's trust chain; certifying PDF/A conformance.

## Phase 14 scope (delivered)

Official submission: how a private PalCert Check becomes something an
institution has formally received, and what stays private when it does.

```
PRIVATE PALCERT CHECK  ≠  OFFICIAL INSTITUTION SUBMISSION
Technical Compliance   ≠  Institution Academic/Administrative Decision
```

**The snapshot is the handoff.** Submitting copies the exact bytes and the
exact report into an immutable snapshot and verifies both; nothing afterwards
reads through to the private document, so a later upload, correction or
deletion cannot change what an institution received.

**`DUAL_PARTY_SCOPED` isolation** is introduced for rows that two parties may
read and neither may unilaterally rewrite: the submitter and the receiving
organization each see the submission, and read being dual-party does not make
write dual-party.

**Two vocabularies never merge.** PalCert's technical determination and the
institution's decision are separate columns, separate words and separate
authorities, in both languages. No route combines them into one status.

**A revision is a new handoff** — a new immutable snapshot under the same
submission — rather than an edit of the one already delivered.

Architecture decisions:
[ADR-0104](../adr/0104-a-private-check-is-not-a-submission.md) through
[ADR-0110](../adr/0110-evidence-hash-excludes-the-decision.md).
Reference: [official-submissions.md](../architecture/official-submissions.md).

Explicitly **not** in Phase 14: certificates (Phase 15); plagiarism or
originality checking; grading; institution-to-institution sharing; any route by
which an organization reaches a document that was never submitted to it.

## Phase 15 scope (delivered)

Compliance certificates and public verification.

```
PalCert Technical Determination = COMPLIANT
              AND
Institution Decision            = APPROVED
```

**Two authorities, one certificate.** Nothing else issues one: no partial
credit, no override, no administrative exception, and no route that asks for
one. Issuance is scheduled inside the decision transaction, so a certificate
cannot exist for a decision that did not commit.

**A certificate is document-bound.** It names one immutable submission revision
and says exactly what the two authorities each determined about it — not that a
degree was awarded, a paper accepted, or quality judged.

**The certificate row holds no capability.** A verification code is sealed with
a key PostgreSQL never holds, so a database compromise on its own cannot turn a
row back into a working verification.

**Revocation changes validity only.** A revoked certificate still verifies, and
answers `REVOKED` — an old QR code telling its holder the certificate was
withdrawn is the entire point of online verification. Public verification
answers the same "not found" for a code that never existed, one still being
prepared and one whose issuance failed, so a stranger learns nothing by
probing.

Architecture decisions:
[ADR-0111](../adr/0111-two-authorities-one-certificate.md) through
[ADR-0115](../adr/0115-the-certificate-row-holds-no-capability.md).
Reference: [certificates.md](../architecture/certificates.md).

Explicitly **not** in Phase 15: accreditation; certificate templates chosen by
organizations; blockchain anchoring; an un-revoke route; any public disclosure
of the submitter's identity or document content.

## Phase 16 scope (delivered)

Notifications and reliable event delivery.

> A notification reports an authoritative event.
> It never becomes the authoritative record itself.

**Nine event types, two channels, five tables.** `IN_APP` and `EMAIL` are a
database enum, so a third channel cannot appear by accident. `domain_events` is
append-only and is the producer-level idempotency root: one committed
authoritative row produces at most one event of a given type, enforced by a
unique index rather than by a service remembering to check.

**`ProcessingJob` remains the one dispatch mechanism.** `domain_events` is not
a second outbox; the rows are the source identity the jobs refer to, and the
reason a retried job cannot notify twice.

**Authority is resolved at delivery**, not at fan-out: a reviewer who lost
their role, an account that was suspended, or a preference changed in between
is honoured at the moment the mail would be sent.

**Workflow mail cannot carry a credential.** Notification mail is configured
separately from authentication mail, so a deployment can switch workflow email
off entirely without disabling the mail that lets people recover accounts. A
certificate revocation email cannot be switched off, and the database refuses a
preference row that says otherwise.

Architecture decisions:
[ADR-0116](../adr/0116-a-notification-is-never-the-authority.md) through
[ADR-0119](../adr/0119-two-retry-ladders-for-one-email.md).
Reference: [notifications.md](../architecture/notifications.md).

Explicitly **not** in Phase 16: outbound webhooks (Phase 17); SMS, push, Slack,
Teams or WhatsApp; digests; marketing email; per-organization mail branding;
inbound mail processing.

## Phase 17 scope (delivered)

Organization integrations and secure outbound webhooks.

```
A webhook is an external projection of an authoritative DomainEvent.
It never becomes the authoritative record itself.
```

The flow:

```
Phase 14/15 authoritative transition
  → Phase 16 DomainEvent (webhookEligible)
  → WEBHOOK_FANOUT
  → WebhookEvent (one per DomainEvent, for ever)
  → subscribed, ACTIVE organization endpoints
  → WebhookDelivery
  → SafeWebhookHttpClient
  → signed HTTPS request
  → durable retries and attempt history
```

Nothing created in this phase may be consulted to decide whether a submission
was approved or a certificate is valid.

Phase 17 delivers: outbound organization webhooks; endpoint management;
immutable, verified configuration versions; HMAC-SHA256 signing over the exact
bytes sent; endpoint verification by signed challenge; DNS re-resolution and
pinned connections on every attempt; SSRF protection from committed IANA deny
registries; an AES-GCM encryption keyring with key ids; durable delivery
attempts; ORIGINAL, TEST and REPLAY delivery kinds; management idempotency;
lost-response secret recovery; key rewrap; subscription management; a bounded
delivery retry ladder; crash recovery; fan-out reconciliation for mixed-version
deployments; RBAC; tenant isolation; and a bilingual management UI.

Explicitly **not** in Phase 17: inbound webhooks; API client credentials;
generic machine API authentication; OAuth integrations; OJS, Crossref, ORCID or
JATS integration; Slack, Teams, WhatsApp, SMS or push; arbitrary webhook
scripting; custom HTTP headers or authentication schemes; mTLS, custom CAs or
self-signed certificates; blockchain; Phase 18 work.

## Phase 18 scope (delivered)

References and citation evidence.

PalCert reads what a document's citations and reference list *are*, and reports
it as evidence. It does not write bibliographies, does not judge sources, and
does not resolve anything over the network.

Phase 18 delivers: reference-region discovery; reference-entry segmentation;
in-text citation discovery; Word-native `CITATION` field and bibliography-source
extraction; structured reference parsing where the evidence supports it;
conservative citation-to-reference linking with `LINKED`, `AMBIGUOUS` and
`UNRESOLVED` outcomes; orphan citations; uncited references; confirmed duplicate
references; DOI, ISBN, ISSN and URL syntax and normalization; reference
completeness evidence; numeric citation labels, ranges and ordering; basic
author-year consistency; citation and reference counts; Arabic, Latin and
mixed-script support; DOCX and PDF with format-specific coverage — all of it as
evidence inside the immutable analysis artifact.

**A deliberately small part of that evidence becomes deterministic fact.** The
approved projector allow-list is the exact Word-native citation count, the exact
Word-managed bibliography source count, whether each native citation resolves to
its source, and the presence of a reference region proven by structure.
Everything else is advisory, shown as observed, unresolved or ambiguous, and
carries no severity, no compliance outcome and no weight in any score.

The governing distinction is authority, not coverage. `PARTIAL` coverage stops
the engine turning incomplete evidence into a false pass; it does **not** stop a
wrong value producing a false failure. So a heuristic observation never becomes
a deterministic fact: a reference count that is really a lower bound would fail
a compliant document, and PalCert would rather say nothing than say that.
Coverage also cannot repair a wrong element identity — a paragraph a heuristic
called a reference entry is not one — so a fact is projected only when both the
element identity and the value are deterministic. The semantic citation and
reference-entry domains are never reported as complete in this phase.

Citation evidence has no authority of its own. It becomes a verdict only by
being projected into facts, evaluated against a published standard version, and
aggregated by the existing compliance engine.

Explicitly **not** in Phase 18: named citation-style conformance (APA, IEEE,
Vancouver, Harvard, Chicago, MLA); CSL or citeproc; citation-style conversion;
bibliography rewriting; any SmartFix correction of citations or reference
entries, formatting included; Crossref, ORCID, live DOI resolution or any
external metadata lookup; AI bibliographic completion or AI-generated authors,
titles, years or identifiers; plagiarism detection; claim-support verification;
scientific merit or source-quality ranking; general logical-section
classification — Phase 18 locates a reference region for its own use and
classifies no other section; deterministic rules over heuristic citation or
reference counts; deterministic rules over inferred bibliographic completeness;
and any negative claim derived from heuristic absence.

## Phase 19 scope (delivered)

Public integration API, API clients and machine authentication.

An organization can issue credentials to a machine and call a deliberately
small, explicitly allow-listed part of PalCert without a person being present.

Phase 19 delivers: organization-owned API clients with a client id and a
show-once secret; secret verification against a one-way Argon2id verifier and
nothing recoverable; creation, rotation with a bounded and explicitly modelled
overlap, revocation, disable/enable and expiry; a machine principal distinct
from a human one, carried into every audit record; an explicit API-client scope
vocabulary that is **not** the organization's permission set, read-only in this
phase; a machine-access
allow-list that a route must opt into by name; per-credential rate limiting on
top of the existing per-IP limits; `Idempotency-Key` on every mutating
integration route; organization-administrator management screens in English and
Arabic with RTL; and OpenAPI plus developer documentation for authentication,
scopes, limits, idempotency and errors.

**A scope is not a permission.** `API_CLIENT` has held zero permissions since
Phase 1, and Phase 19 does not change that by translating the role into an
organization's rights. A client holds scopes, a scope maps to a named
allow-listed operation, and an operation that no scope names is unreachable —
so adding a route never widens machine access by accident, which is the failure
this design exists to prevent.

**The Phase 17 boundary is authoritative and unchanged.** A webhook signing
secret authenticates PalCert *to* a receiver. It is outbound, it is sealed
under the keyring, and it is never an inbound PalCert credential. API-client
secrets are a separate capability with a separate store, a separate lifecycle
and a separate verifier: neither can be presented where the other is expected.

**Rotation has an explicit overlap model.** Rotating mints a second secret and
puts the previous one into a bounded overlap during which both verify, so a
deployment can be updated without downtime. The overlap has a fixed maximum, it
is recorded on the credential, and it ends — a rotation that left the old
secret valid for ever would be an accidental permanent second credential, which
is the thing rotation is supposed to remove. Revocation ends it immediately.

**An API client is never a person.** It belongs to exactly one organization,
holds no membership, cannot switch organizations, and cannot act as the user
who created it. Audit records name the client, never a borrowed human identity.

Explicitly **not** in Phase 19: machine access to submission evidence — the
attached document or the report — which is a different decision from telling an
integration that a submission arrived and needs its own scope, its own
short-lived URLs and its own audit trail rather than being bundled into a
metadata read; write operations of any kind, since a machine that can act
wrongly at scale is a different class of incident from one that can only read
(the idempotency machinery is built regardless, so the first write route is not
the moment somebody designs retry semantics under pressure); user-private
checks, balances, payments,
payment-provider metadata, invoices or any finance mutation; unrestricted
document content or download of another party's evidence; certificate issuance,
revocation or any certificate control; platform administration, user
administration or organization verification decisions; submission decisions;
SmartFix execution; standards authoring or publication; OAuth 2.0, OIDC, JWT
bearer tokens, refresh tokens, mTLS or signed-request authentication — Phase 19
uses a client id and secret over TLS and nothing more; public developer
self-service registration; per-client billing or usage metering; API versioning
beyond the existing route surface; and any change to finance semantics,
certificate eligibility, citation semantics, submission authority or webhook
signing.

## Phase 20 scope (delivered)

Production readiness, operations and the final PalCert v1 release.

**Phase 20 is a production-hardening and release phase, not a feature-
development phase.** Its purpose is to turn the completed application into a
system that can be deployed, observed, recovered and operated by people who did
not build it. No new product capability is in scope, and no Phase 1–19 decision
is reopened.

A new idea discovered during Phase 20 is recorded as a post-v1 roadmap item.
The only five exceptions — the only things that may be built in this phase
because they were discovered in it — are:

* a security defect;
* a correctness defect;
* a data-loss risk;
* a deployment blocker;
* a production-operability blocker.

"Would be nice in production" is none of those. The distinction is deliberate,
because a hardening phase with an open definition of "necessary" becomes an
unbounded one, and PalCert v1 would never ship.

Phase 20 delivers: a documented production topology and component inventory; an
environment, configuration and secret inventory with a lifecycle for every
cryptographic value; a health and readiness model that proves what it claims;
the minimum production observability signals — API latency and error rate,
queue depth, job age, dead-job count, analyzer failures, payment failures,
webhook delivery failures, notification backlog, certificate issuance failures,
storage errors and authentication anomalies; backup coverage for PostgreSQL and
object storage with a **restore actually performed into a clean environment**;
stated RPO and RTO targets with the values that need an owner decision marked as
such; a retention position for every unbounded operational table; a deployment
and rollback procedure that distinguishes application rollback from database
rollback from forward-fix-only migrations; a load plan derived from a stated
workload; remediation of the findings the Checkpoint 20.1 audit classifies as
RELEASE BLOCKER or HIGH; and a frozen release-candidate commit that passes every
release gate.

**The audit precedes the work.** Checkpoint 20.1 is read-only: it inventories,
measures and classifies, and it implements nothing. Every subsequent checkpoint
draws its work from the readiness ledger that 20.1 produces, so nothing is
hardened on a hunch and nothing that matters is hardened by accident.

**Evidence before mechanism.** Phase 20 does not partition a table because it
might grow, add a vendor observability stack because observability is good, or
set an RPO because a number was needed. Each of those is a decision with a cost,
and each requires either measured evidence or a recorded owner decision.

Explicitly **not** in Phase 20: any new product capability; any change to
finance semantics, certificate eligibility, citation semantics, advisory/
authoritative separation, submission authority, webhook signing or API-client
scope semantics; multi-region or active-active deployment; Kubernetes (ADR-0006
keeps it out of v1); autoscaling policy; a public developer portal; SOC 2, ISO
27001 or any certification programme; penetration testing by a third party;
customer-facing SLAs; per-tenant usage metering or billing changes; data
residency guarantees; and any migration that rewrites existing evidence.

**Delivered** through nine checkpoints:

- 20.1, the audit;
- 20.2, runtime and deployment;
- 20.3, observability and alerting;
- 20.4, backup, restore and disaster recovery;
- 20.5, registry, CI/CD and release delivery;
- 20.6, performance and capacity;
- 20.7, security and configuration hardening;
- 20.8, operations, UX and release QA;
- 20.9, the final release candidate.

The release candidate `4554c7a` passed every release gate on one set of five
image digests. Those gates were the supply chain, a fresh install, an upgrade
from the Phase 19 schema, a recovery from the registry, staging acceptance with
payments enabled and disabled, the full 960-step browser matrix, operations,
security, performance, three consecutive end-to-end runs and golden
compatibility.

## Definition of done (§41)

A phase is complete only when every applicable item holds:

- [ ] Requirements implemented
- [ ] Database migrations created
- [ ] Authorization verified
- [ ] Validation implemented
- [ ] Error handling implemented
- [ ] Logging implemented
- [ ] Tests passing (no knowingly failing tests)
- [ ] Documentation updated
- [ ] API documented
- [ ] Security reviewed
- [ ] No critical TODOs
- [ ] No hard-coded secrets
- [ ] No known critical defects
- [ ] Acceptance criteria verified

A working UI alone is never "done".
