# Architecture decision records

Each ADR records one significant decision, the forces behind it and its
consequences. ADRs are immutable once accepted: to change a decision, add a new
ADR that supersedes the old one and update the old one's status.

| ID | Title | Status |
| --- | --- | --- |
| [0001](0001-modular-monolith-with-document-workers.md) | Modular monolith with independent document workers | Accepted |
| [0002](0002-hybrid-deterministic-and-ai-compliance.md) | Hybrid deterministic + AI compliance architecture | Accepted |
| [0003](0003-ai-provider-abstraction.md) | AI provider abstraction | Accepted |
| [0004](0004-organization-as-tenant.md) | `Organization` as the tenant primitive | Accepted |
| [0005](0005-postgresql-with-prisma.md) | PostgreSQL with Prisma as the ORM and migration tool | Accepted |
| [0006](0006-docker-compose-for-mvp.md) | Docker Compose for the MVP, no Kubernetes | Accepted |
| [0007](0007-blockchain-ready-not-blockchain-integrated.md) | Blockchain-ready, not blockchain-integrated | Accepted |
| [0008](0008-testing-stack.md) | Testing stack: Vitest, Jest, pytest | Accepted |
| [0009](0009-structured-logging-and-correlation-ids.md) | Structured logging and correlation IDs | Accepted |
| [0010](0010-arabic-english-rtl-first.md) | Arabic/English and RTL from day one | Accepted |
| [0011](0011-opaque-server-side-sessions.md) | Opaque server-side sessions, not browser-held JWTs | Accepted |
| [0012](0012-argon2id-password-hashing.md) | Argon2id for password hashing | Accepted |
| [0013](0013-totp-mfa-strategy.md) | TOTP as the first multi-factor authenticator | Accepted |
| [0014](0014-csrf-strategy.md) | Layered CSRF protection | Accepted |
| [0015](0015-admin-bootstrap.md) | Administrator bootstrap by explicit CLI | Accepted |
| [0016](0016-global-and-organization-scoped-roles.md) | Global roles now, organization-scoped roles by construction | Accepted |
| [0017](0017-organization-membership-model.md) | Organization, membership and scoped roles as three things | Accepted |
| [0018](0018-postgresql-row-level-security.md) | PostgreSQL row-level security and database role separation | Accepted |
| [0019](0019-tenant-context-and-connection-pooling.md) | Transaction-local tenant context | Accepted |
| [0020](0020-cursor-pagination-convention.md) | Cursor pagination as the collection convention | Accepted |
| [0021](0021-organization-verification-lifecycle.md) | Organization verification as an attempt history | Accepted |
| [0022](0022-rules-are-data-not-code.md) | Rules are data, never an executable expression | Accepted |
| [0023](0023-standard-content-hashing.md) | Published standard versions carry a canonical content hash | Accepted |
| [0024](0024-published-immutability.md) | Published standard versions are immutable, at both layers | Accepted |
| [0025](0025-optimistic-concurrency-for-drafts.md) | One optimistic-concurrency strategy, via If-Match | Accepted |
| [0026](0026-normalized-fact-model.md) | Rules are evaluated against a normalized fact model, never a document | Accepted |
| [0027](0027-exact-decimal-arithmetic.md) | Exact rational arithmetic for measurements; no binary floating point | Accepted |
| [0028](0028-evaluation-result-semantics.md) | Four outcomes, and neither absence nor error ever becomes a verdict | Accepted |
| [0029](0029-cross-language-contract-source-of-truth.md) | One JSON Schema is the source of truth for every cross-language contract | Accepted |
| [0030](0030-rule-schema-v2-blocking-semantics.md) | Rule Schema v2 — blocking in any evaluation mode, versioned not retroactive | Accepted |
| [0031](0031-user-private-document-ownership.md) | Documents are user-private; organizations never own or see them | Accepted |
| [0032](0032-direct-to-storage-upload.md) | Uploads go directly to object storage through a presigned PUT | Accepted |
| [0033](0033-quarantine-and-clean-buckets.md) | Two buckets — quarantine for untrusted bytes, clean for promoted ones | Accepted |
| [0034](0034-object-versioning-defeats-presigned-reuse.md) | The finalized object *version* is the artifact, not the key | Accepted |
| [0035](0035-malware-scanning-as-a-gate.md) | Malware scanning is a gate; a scanner error is never a pass | Accepted |
| [0036](0036-transactional-outbox-and-bullmq.md) | Processing intent is a database row; BullMQ only carries the id | Accepted |
| [0037](0037-at-least-once-delivery-and-db-leases.md) | Delivery is at-least-once; the ledger decides who runs and when | Accepted |
| [0038](0038-document-version-immutability.md) | A document version is immutable; a new upload is a new version | Accepted |
| [0039](0039-raw-ooxml-parsing.md) | PalCert reads OOXML directly, and versions the analyzer that does | Accepted |
| [0040](0040-effective-formatting-resolution.md) | Effective formatting, with provenance, computed by specification | Accepted |
| [0041](0041-analysis-artifacts-are-immutable.md) | An analysis is immutable, versioned, and reusable | Accepted |
| [0042](0042-derived-artifact-storage.md) | A third bucket for derived data, reachable by no browser | Accepted |
| [0043](0043-structural-analysis-knows-no-pages.md) | Structural analysis does not know where a page begins | Accepted |
| [0044](0044-script-aware-typography.md) | Typography is resolved per script, not per run | Accepted |
| [0045](0045-tracked-changes-final-view.md) | The analysis view is FINAL, and says so | Accepted |
| [0046](0046-check-binds-exact-identities.md) | A check binds exact identities at creation | Accepted |
| [0047](0047-compliance-determination-separate-from-status.md) | Compliance determination is separate from processing status | Accepted |
| [0048](0048-deterministic-score-scope-and-arithmetic.md) | The score is deterministic, exact, and bounded in meaning | Accepted |
| [0049](0049-report-canonicalization-and-hashing.md) | Reports are canonicalized before they are hashed | Accepted |
| [0050](0050-public-standard-catalogue-via-security-definer.md) | The public catalogue is a SECURITY DEFINER boundary | Accepted |
| [0051](0051-checks-are-user-scoped.md) | Checks, findings and reports are user-scoped | Accepted |
| [0052](0052-one-rule-engine-behind-an-http-boundary.md) | Exactly one rule evaluator, behind a narrow HTTP boundary | Accepted |
| [0053](0053-bounded-violation-storage.md) | Violations are capped, and the cap is always disclosed | Accepted |
| [0054](0054-ai-provider-behind-a-port.md) | The AI provider sits behind a port, and there is exactly one of them | Accepted |
| [0055](0055-ai-output-is-advisory-not-truth.md) | AI output is advisory; deterministic evidence is authoritative | Accepted |
| [0056](0056-prompt-and-context-are-versioned.md) | Prompts and context builders are versioned, and every invocation records which was used | Accepted |
| [0057](0057-ai-context-is-minimized.md) | PalCert sends selected evidence, never the document | Accepted |
| [0058](0058-external-ai-processing-requires-consent.md) | External AI processing happens only after the person agrees | Accepted |
| [0059](0059-structured-output-is-validated-not-parsed.md) | Model output is schema-constrained and validated, never parsed out of prose | Accepted |
| [0060](0060-ai-reviews-are-immutable-and-hashed.md) | A completed AI review is immutable, and hashed separately from the report | Accepted |
| [0061](0061-standard-sources-are-organization-owned.md) | A Standard's source documents are owned by the organization, not by the uploader | Accepted |
| [0062](0062-secure-ingestion-is-shared-not-copied.md) | Organization source uploads reuse the Phase 5 ingestion pipeline verbatim | Accepted |
| [0063](0063-two-pass-extraction-citations-then-structure.md) | Extraction is two passes — citations first, structure second | Accepted |
| [0064](0064-template-observations-are-measurements-not-requirements.md) | A template is measured deterministically, and what it shows is never a requirement | Accepted |
| [0065](0065-ai-proposals-require-human-acceptance.md) | An AI proposal becomes a rule only when a person accepts it | Accepted |
| [0066](0066-organization-ai-consent-is-separate-from-personal-consent.md) | An institution's agreement to external AI processing is separate from a person's | Accepted |
| [0067](0067-rule-provenance-is-preserved-and-outside-the-content-hash.md) | Accepted-rule provenance is preserved, and deliberately outside the standard's content hash | Accepted |
| [0068](0068-integer-minor-unit-money.md) | Money is an integer count of minor units, and a string on the wire | Accepted |
| [0069](0069-append-only-credit-ledger.md) | The balance is a derived sum of an append-only ledger | Accepted |
| [0070](0070-credit-holds-and-row-locks.md) | Spending is a two-step reservation, serialized by a row lock | Accepted |
| [0071](0071-payment-provider-port.md) | The payment provider sits behind a port, and business logic never imports it | Accepted |
| [0072](0072-stripe-hosted-checkout-reference-adapter.md) | Stripe Hosted Checkout is the reference adapter, and PalCert never touches a card | Accepted |
| [0073](0073-webhook-is-the-payment-authority.md) | The verified webhook is the payment authority; the browser redirect is not | Accepted |
| [0074](0074-price-versioning.md) | Prices are immutable versions; the client never names a price | Accepted |
| [0075](0075-external-refund-versus-balance-refund.md) | A refund to a card and a refund to the balance are different acts | Accepted |
| [0076](0076-provider-events-are-at-least-once-and-unordered.md) | Provider events are at-least-once, unordered, and never self-describing | Accepted |
| [0077](0077-service-purchase-domain.md) | A purchase is a reusable domain, not a column on a check | Accepted |
| [0078](0078-charge-on-delivery-not-on-attempt.md) | A check is charged for a delivered report, not for an attempt | Accepted |
| [0079](0079-atomic-commercial-creation.md) | Buying and starting a check is one transaction, with preallocated ids | Accepted |
| [0080](0080-completion-and-capture-are-one-transaction.md) | Completion and capture are one transaction, guarded by a row lock | Accepted |
| [0081](0081-reservation-lifetime-and-paid-retry.md) | A reservation has a product-specific lifetime, and a paid retry is a new purchase | Accepted |
| [0082](0082-billing-stays-out-of-the-report.md) | Billing never enters the canonical report | Accepted |

| [0083](0083-smartfix-corrects-a-copy.md) | SmartFix corrects a copy; the original is never modified | Accepted |
| [0084](0084-a-plan-is-free-hashed-and-executed-as-approved.md) | A plan is free, hashed, and executed exactly as approved | Accepted |
| [0085](0085-capability-registry-is-the-floor.md) | The capability registry is the floor; `autofix: SAFE` is a ceiling | Accepted |
| [0086](0086-only-operators-with-one-target.md) | Only operators that name a single value are corrected | Accepted |
| [0087](0087-script-channels-are-part-of-the-capability.md) | A script channel is part of the capability, not a mutator detail | Accepted |
| [0088](0088-the-manifest-is-computed-from-the-output.md) | The change manifest is computed from the output, never from the plan | Accepted |
| [0089](0089-a-correction-is-a-hidden-document-version.md) | A correction is a real document version, hidden until delivered | Accepted |
| [0090](0090-the-recheck-is-an-ordinary-check-with-a-purpose.md) | The recheck is an ordinary check, classified in the database | Accepted |
| [0091](0091-numeric-targets-are-round-tripped.md) | A numeric target is round-tripped through OOXML units before it is planned | Accepted |
| [0092](0092-pdf-is-an-inspection-format-not-a-smartfix-format.md) | PDF is an inspection format, never a SmartFix format | Accepted |
| [0093](0093-tagged-structure-binds-through-marked-content.md) | Semantic roles come from marked content ids, or they do not come at all | Accepted |
| [0094](0094-observed-inset-is-not-a-margin.md) | An observed content inset is a separate property from a margin | Accepted |
| [0095](0095-analysis-runs-in-a-bounded-child-process.md) | Every PDF analysis runs in its own bounded child process | Accepted |
| [0096](0096-no-ocr-in-phase-13.md) | A scanned PDF is reported as a scan, not run through OCR | Accepted |
| [0097](0097-metadata-provenance-is-preserved.md) | Both metadata sources are kept, and the chosen one is named | Accepted |
| [0098](0098-licence-review-before-a-pdf-dependency.md) | pypdfium2 and pikepdf, chosen on licence before capability | Accepted |
| [0099](0099-a-pdf-page-count-is-authoritative.md) | The PDF's page count is authoritative; a DOCX has none | Accepted |
| [0100](0100-a-zero-coverage-standard-is-refused-not-sold.md) | A standard with no answerable rule is refused, not sold | Accepted |
| [0101](0101-the-artifact-envelope-stays-at-v1.md) | PDF reuses the v1 artifact envelope and Fact Schema v2 | Accepted |
| [0102](0102-signature-and-pdfa-claims-are-not-verdicts.md) | A signature field and a PDF/A claim are reported as presence, never as validity | Accepted |
| [0103](0103-active-content-is-counted-never-executed.md) | Active content is counted, and nothing in a PDF is ever executed or fetched | Accepted |
| [0104](0104-a-private-check-is-not-a-submission.md) | A private check is never an official submission | Accepted |
| [0105](0105-the-snapshot-is-the-handoff.md) | An official submission hands over a snapshot, not a reference | Accepted |
| [0106](0106-dual-party-scoped-isolation.md) | `DUAL_PARTY_SCOPED`, a fifth isolation class | Accepted |
| [0107](0107-read-is-dual-party-write-is-not.md) | Reading a submission is dual-party; writing it is not | Accepted |
| [0108](0108-two-vocabularies-never-merge.md) | Preparation status and institution decision are two vocabularies | Accepted |
| [0109](0109-a-revision-is-a-new-handoff.md) | A resubmission is a new revision, never a rewrite | Accepted |
| [0110](0110-evidence-hash-excludes-the-decision.md) | The evidence hash covers evidence, never the decision | Accepted |
| [0111](0111-two-authorities-one-certificate.md) | A certificate requires both authorities, with no partial credit | Accepted |
| [0112](0112-issuance-is-scheduled-inside-the-decision.md) | Issuance is scheduled inside the decision transaction | Accepted |
| [0113](0113-a-certificate-is-document-bound.md) | A certificate is document-bound, not person-bound | Accepted |
| [0114](0114-revocation-changes-validity-only.md) | Revocation changes validity and nothing else | Accepted |
| [0115](0115-the-certificate-row-holds-no-capability.md) | The certificate row holds no verification capability | Accepted |
| [0116](0116-a-notification-is-never-the-authority.md) | A notification reports an authoritative event and never becomes one | Accepted |
| [0117](0117-authority-is-resolved-at-delivery.md) | Authority and eligibility are resolved when the message is sent | Accepted |
| [0118](0118-workflow-mail-cannot-carry-a-credential.md) | Workflow mail gets its own port, so it cannot carry a credential | Accepted |
| [0119](0119-two-retry-ladders-for-one-email.md) | Two retry ladders, because they are waiting for different things | Accepted |
| [0120](0120-domainevent-is-the-outbound-source.md) | The `DomainEvent` is the only source of an outbound webhook | Accepted |
| [0121](0121-webhooks-are-not-a-notification-channel.md) | Webhooks are their own subsystem, not a `NotificationChannel` | Accepted |
| [0122](0122-immutable-endpoint-configuration-versions.md) | An endpoint's URL and secret live in immutable configuration versions | Accepted |
| [0123](0123-dns-pinning-and-committed-iana-snapshots.md) | The SSRF boundary pins DNS and classifies against committed IANA snapshots | Accepted |
| [0124](0124-two-retry-ladders-for-one-webhook.md) | A receiver's answer never enters the queue's retry ladder | Accepted |
| [0125](0125-an-attempt-and-its-parent-are-one-write.md) | Beginning and finishing an attempt are each one write | Accepted |
| [0126](0126-at-least-once-with-receiver-side-dedup.md) | At-least-once delivery, deduplicated on the event id | Accepted |
| [0127](0127-management-idempotency-and-bounded-secret-recovery.md) | Durable management intents, and a bounded window to re-read a secret | Accepted |
| [0128](0128-a-key-id-from-day-one.md) | The webhook keyring carries a key id from day one | Accepted |
| [0129](0129-rotation-preserves-the-sealed-destination.md) | A secret rotation re-seals the destination, it does not rebuild it | Accepted |
| [0130](0130-the-bibliography-store-is-found-by-its-root-element.md) | The bibliography source store is found by its root element | Accepted |
| [0131](0131-the-envelope-version-and-the-structural-model-version-are-separate.md) | The artifact envelope and the structural model version separately | Accepted |
| [0132](0132-citation-target-resolution-is-its-own-property.md) | Citation-target resolution is its own property, not a widened one | Accepted |
| [0133](0133-heuristic-citation-evidence-is-quarantined-from-facts.md) | Heuristic citation evidence is quarantined from facts | Accepted |
| [0134](0134-author-year-recognition-is-anchored-not-searched.md) | Author-year recognition is anchored, not searched | Accepted |
| [0135](0135-a-parsed-field-must-be-findable-in-the-raw-text.md) | A parsed bibliographic field must be findable in the raw text | Accepted |
| [0136](0136-a-citation-carries-the-same-identifier-a-reference-does.md) | A citation carries the same identifier object a reference does | Accepted |
| [0137](0137-a-document-may-have-several-reference-lists.md) | A document may have several reference lists | Accepted |
| [0138](0138-a-raised-numeral-is-a-citation-only-when-it-names-something.md) | A raised numeral is a citation only when it names something | Accepted |
| [0139](0139-heuristic-evidence-is-reported-and-never-decides.md) | Heuristic evidence is reported and never decides | Accepted |
| [0140](0140-advisory-evidence-is-inert-in-the-determination.md) | Advisory evidence is inert in the determination | Accepted |
| [0141](0141-a-machine-is-a-principal-not-a-borrowed-person.md) | A machine is a principal, not a borrowed person | Accepted |
| [0142](0142-a-legacy-equation-is-data-never-a-program.md) | A legacy equation is data, never a program | Accepted |
| [0143](0143-publishing-a-successor-supersedes-the-version-in-force.md) | Publishing a successor supersedes the version in force | Accepted |
| [0144](0144-portable-standard-packages.md) | Portable standard packages are content, imported only as drafts | Accepted |
| [0145](0145-user-submitted-certificate-attestation.md) | Institutions attest the exact bytes a user submits; PalCert records and settles | Accepted |
| [0146](0146-admin-managed-transactional-email.md) | Admin-managed transactional email provider and encrypted provider credentials | Accepted |
| [0147](0147-manual-topups-and-human-payment-verification.md) | Manual top-ups: bank and app transfers credited only after PalCert finance verifies them | Accepted |
| [0148](0148-payment-method-reviewer-assignment.md) | Payment-method reviewer assignment: alerts go to each method's assigned finance reviewers, with a recorded fallback | Accepted |
| [0149](0149-centralized-billing-for-customer-initiated-ai-services.md) | Centralized billing for customer-initiated AI services: the initiating user pays, reserved before, charged on COMPLETED, released otherwise | Accepted |
| [0150](0150-unified-withdrawals-and-payout-settlement.md) | Unified withdrawals and payout settlement: user, organization and platform payouts reserved at submission, approved by someone else, settled exactly once on PAID | Accepted |

## Template

```markdown
# ADR-XXXX: Title

- **Status:** Proposed | Accepted | Superseded by ADR-YYYY
- **Date:** YYYY-MM-DD
- **Phase:** N

## Context
## Decision
## Alternatives considered
## Consequences
```
