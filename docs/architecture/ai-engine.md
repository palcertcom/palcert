# The AI engine

> Phase 8. A second opinion on the requirements that need reading rather than
> measuring — bolted alongside the deterministic report, never into it.

```
DocumentCheck (COMPLETED)  ─►  AIReview  ─►  AIInvocation  (one per provider call)
        │                         │
        │                         ├─►  AIRuleAssessment   (advisory, per rule)
        │                         └─►  AIReportSupplement (bilingual summary + next steps)
        │
        └─ CheckReport, CheckRuleResult, CheckViolation  ── untouched, byte for byte
```

## The one principle

**Deterministic results are authoritative technical measurements. AI results
are structured semantic assessments and explanations.** The AI layer never
rewrites deterministic evidence or a historical report (ADR-0055).

Everything below is a consequence of that sentence.

## Where AI is allowed to run

Only on a **completed** check, and only for rules the standard marked
`AI_ASSISTED`. Concretely:

| Rule `evaluationMode` | Phase 7 does                          | Phase 8 does           |
| --------------------- | ------------------------------------- | ---------------------- |
| `DETERMINISTIC`       | measures, PASS/FAIL                   | nothing                |
| `AI_ASSISTED`         | `INDETERMINATE` + `AI_REVIEW_REQUIRED`| an advisory assessment |
| `MANUAL`              | `INDETERMINATE` + `MANUAL_REVIEW_REQUIRED` | **nothing** — a manual rule is never sent to a model |

A failed or incomplete check is never reviewed: there is nothing trustworthy to
explain, and explaining it anyway would give a broken run an air of authority.

## Provider abstraction

`AIProviderPort` (in `@palcert/contracts`) is the only way AI work leaves the
application. It exposes `getCapabilities`, `countTokens`, `assessRules`,
`generateReportSupplement` and `checkAvailability` — and nothing vendor-shaped.

| Implementation        | Where                                   | Used by                    |
| --------------------- | --------------------------------------- | -------------------------- |
| `AnthropicAIProvider` | `apps/api/src/infrastructure/ai/`       | every real deployment      |
| `FakeAIProvider`      | same directory, refused in production   | tests only                 |

Configuration validation **rejects the fake provider when `NODE_ENV=production`**
(ADR-0054). There is no third adapter for symmetry, and there is no fallback to
a second company when the configured provider fails.

### The Anthropic adapter

- Sets `model`, `max_tokens`, `system`, `messages` and `output_config` — and
  nothing else. No tools, no `tool_choice`, no `temperature`, `top_p` or
  `top_k`, no assistant prefill.
- Runs with the SDK's own retries disabled (`maxRetries: 0`). PalCert owns
  retry, because PalCert owns the ledger that records each attempt.
- Maps provider errors onto PalCert's own `AIFailureKind`, and reads
  `Retry-After` when the provider sends one.
- Treats `stop_reason: 'refusal'` as `PROVIDER_REFUSAL` and
  `stop_reason: 'max_tokens'` as `OUTPUT_INVALID` — a truncated structured
  response is not a partial success.

### Model configuration

The exact model name is **configuration, not identity**: `AI_MODEL`. Both the
name PalCert asked for (`configuredModel`) and the name the provider reported
(`providerReturnedModel`) are stored on every review and invocation, because
they can differ and the difference matters when explaining an old result.

## Consent

No document content leaves PalCert until its owner has agreed (ADR-0058).

`AIConsent` records `consentVersion`, `consentedAt` and `providerCategory`, one
row per user. The UI states, before the button and in both languages: what is
sent, what is not, that processing happens at an external provider, and that
retention is governed by PalCert's agreement with that provider. PalCert does
not promise Zero Data Retention.

Consent belongs to the user. An organization cannot grant it on a student's
behalf, and never sees the resulting review. Raising `AI_CONSENT_VERSION` asks
again rather than assuming agreement to a notice nobody read. Withdrawal stops
new reviews and leaves existing ones readable.

## The context bundle

PalCert never sends the file, the ZIP bytes, or OOXML internals. It sends a
normalized bundle built by `AIContextBuilder` from the Phase 6 structural model
(ADR-0057):

| Part                    | Contents                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `outline`               | headings, for orientation                                       |
| `nodes`                 | paragraphs selected as relevant to the requested rules          |
| `metadata`              | counts, and declared author/title/company where a rule needs them|
| `deterministicFindings` | what was already measured for those rules                       |
| `rules`                 | code, severity, blocking, bilingual title and guidance          |
| `truncation`            | whether the bundle was cut, why, and how many nodes were dropped |

Selection is bilingual keyword matching plus heading proximity. Everything is
bounded — `AI_MAX_NODE_CHARS`, `AI_MAX_CONTEXT_NODES`, `AI_MAX_CONTEXT_CHARS`,
`AI_MAX_RULES_PER_REQUEST` — and when a bound bites, the truncation is **stated
to the model**, with an instruction to answer `INSUFFICIENT_EVIDENCE` rather
than infer material nobody supplied.

Nothing about PalCert's infrastructure goes in the bundle: no API keys, no
database or storage credentials, no signed URLs, no service tokens, no session
identifiers.

## Prompt injection

Document text is hostile input. A thesis can contain "ignore all previous
instructions", and so can an organization's own rule guidance — PalCert
controls neither.

- **Prompts are constants.** `prompt-registry.ts` holds fixed strings with no
  interpolation, so there is no code path by which document text reaches a
  system-level instruction.
- **Untrusted text is escaped, not trusted.** `encodeUntrusted` strips control
  characters and escapes `&`, `<`, `>`, so no substring of a document can close
  a section and open something that reads as authority.
- **Untrusted text lives only in data sections** of the *user* message:
  `<document_evidence>`, `<rules>`, `<document_metadata>`,
  `<deterministic_findings>`.
- **The system prompt says so**, telling the model that the evidence is data
  and never an instruction, and that it has no tools.
- **Nothing the model says changes what PalCert does.** Validation is by
  schema and by the request, not by the response's own claims.

`prompt-injection.spec.ts` asserts these structurally: delimiter counts stay
balanced with hostile content in every field, and a node id mentioned *inside*
document text is not a supplied node.

## Structured output and validation

Output is requested through `output_config.format` with a JSON schema, and then
validated anyway (ADR-0059). `AIOutputValidator` rejects a response that:

- fails `ai-assessment.schema.json`;
- assesses a rule that was not requested;
- assesses a rule twice;
- omits a rule that was requested;
- cites a node id PalCert did not supply;
- reaches a verdict other than `INSUFFICIENT_EVIDENCE` while citing nothing.

Rejections carry no model text, so an invalid response cannot smuggle content
into a log or an error body.

## Assessment semantics

| Value                   | Means                                                     |
| ----------------------- | --------------------------------------------------------- |
| `SATISFIED`             | the supplied evidence appears to meet the requirement      |
| `NOT_SATISFIED`         | the supplied evidence appears not to meet it               |
| `INSUFFICIENT_EVIDENCE` | the supplied evidence cannot settle it                     |

Deliberately not `PASS`/`FAIL`: sharing Phase 7's vocabulary would invite a
reader to treat an opinion as a measurement. There is no confidence number —
a model asked for `0.93` will produce one and it will mean nothing — only a
closed set of reason codes and uncertainty reasons.

`INSUFFICIENT_EVIDENCE` is described to the model as a correct and expected
answer. A refusal to guess is the behaviour PalCert wants.

### Blocking rules

For a **blocking** `AI_ASSISTED` rule, PalCert records
`requiresHumanReview = true` regardless of what the model concluded. The value
is computed from `rule.blocking`, never taken from the response, and a database
CHECK constraint (`ai_rule_assessments_blocking_requires_human`) refuses any row
that says otherwise. The AI provider has no certification authority.

## The report supplement

A bilingual plain-language summary of the technical report plus prioritized next
steps. Built from **results, not from the document** — re-sending the manuscript
to write a summary would abandon minimization for no benefit.

It must not contain a new compliance score, a new determination, a university
decision, a certificate status, a research-quality or novelty judgement, or an
accept/reject recommendation. It never says "this issue has been fixed", and
where prose and machine evidence disagree, machine evidence wins. Supplement
generation is best-effort: losing it does not fail the review it was
summarizing.

## Immutability and hashing

A completed review and its output are append-only, enforced by triggers
(ADR-0060). Re-running produces a new review; an old completed one is never
overwritten.

`aiReviewHash` covers a canonical digest of the AI review only — RFC 8785 JCS,
assessments sorted by rule code, canonicalization version pinned. **It is never
mixed with the Phase 7 `reportHash` or `evaluationHash`,** which stay untouched.

Before calling the provider, the job handler re-verifies every binding the
review captured — `reportHash`, `evaluationHash`, `documentSha256`,
`standardContentHash`, artifact `sha256` (by re-hashing the bytes) — and fails
with `EVIDENCE_INTEGRITY_FAILED` if anything moved. An AI review never runs
against "the latest" anything.

## Failure handling

| `AIFailureKind`             | Cause                                    | Retried |
| --------------------------- | ---------------------------------------- | ------- |
| `RATE_LIMITED`              | 429                                      | yes     |
| `OVERLOADED`                | 529, or 5xx                              | yes     |
| `TIMEOUT`                   | 408, or a client-side deadline           | yes     |
| `NETWORK`                   | connection failure                       | yes     |
| `AUTHENTICATION`            | 401 / 403                                | no      |
| `INVALID_REQUEST`           | 400                                      | no      |
| `MODEL_UNAVAILABLE`         | 404                                      | no      |
| `PROVIDER_REFUSAL`          | `stop_reason: 'refusal'`                 | no      |
| `OUTPUT_INVALID`            | schema or cross-check failure            | no      |
| `CONTEXT_TOO_LARGE`         | bundle exceeds the token budget          | no      |
| `EVIDENCE_INTEGRITY_FAILED` | a captured identity no longer matches    | no      |
| `RESERVATION_EXPIRED`       | the paid reservation lapsed before the call | no   |

Retries are bounded, exponential, and honour `Retry-After`. Each attempt is its
own `AIInvocation` row. PalCert does **not** claim exactly-once provider calls:
a crash between the call and the write is possible, which is why the invocation
is opened *before* the call rather than after it.

Job statuses are `QUEUED` / `RUNNING` / `COMPLETED` / `FAILED` / `CANCELLED` —
never `PASS` or `FAIL`, which belong to rules.

## Billing

AI review is a paid service ([ADR-0149](../adr/0149-centralized-billing-for-customer-initiated-ai-services.md),
[AI billing](ai-billing.md)). A start request carries a `priceQuoteId`, and
the initiating user's balance is reserved before the review exists. The
reservation is captured when the review reaches COMPLETED and released when
it ends FAILED or CANCELLED. The worker re-checks the reservation before
every provider call.

## Health

`GET /api/health/ai` reports provider availability. `/health/ready` deliberately
**does not** probe the provider: a third-party model API being unavailable must
never take PalCert's deterministic product out of a load balancer. A unit test
asserts readiness never calls `checkAvailability`.

## Queue and worker

AI review reuses the existing BullMQ processing-job infrastructure — a new
`AI_REVIEW` job type, not a new framework. Rules are batched
(`AI_MAX_RULES_PER_REQUEST`) so a ten-requirement standard is two provider calls
rather than ten, and the same evidence is not paid for ten times.

## Isolation and privacy

AI tables are `USER_SCOPED`, carry `owner_user_id`, and are protected by
`FORCE ROW LEVEL SECURITY` matching `app_current_user_id()` — the same posture
as Phase 7 checks (ADR-0051). An organization does not see a student's AI
review merely because its standard was used. Another user's review id returns
404, never 403.

By default PalCert does **not** persist raw provider requests or responses.
Hashes prove which normalized inputs were used without storing them.

`ANTHROPIC_API_KEY` is a server secret. It must never appear in the frontend,
a browser bundle, an API response, a queue payload, a log, an audit event, the
database, or an error response. Logger redaction covers the key and the
prompt/response fields, and a test asserts it.

Metric labels are bounded cardinality: provider, model, purpose, outcome. Never
a document title, a user email, rule text or a document excerpt.

## Presentation

The AI review renders **after** the deterministic findings, never mixed into
them, and each assessment is shown as three separate lines:

```
Machine status   INDETERMINATE (AI review required)
AI assessment    Appears satisfied
Final status     Human review still required
```

Wording never says approved, accepted or certified; never uses alarmist
phrasing; and never offers a score. Arabic and English come from the model as
separate fields — the page picks one, it does not machine-translate the other.

## Testing

| Suite                          | What it protects                                           |
| ------------------------------ | ---------------------------------------------------------- |
| `ai-review.e2e-spec.ts`        | the whole flow, and the mandatory report-immutability proof |
| `ai-isolation.e2e-spec.ts`     | RLS, cross-user 404s, organization non-access               |
| `ai-performance.e2e-spec.ts`   | batching, context size, invocation/token accounting         |
| `prompt-injection.spec.ts`     | injection defences, structurally                            |
| `ai-benchmark` + golden corpus | assessment agreement and unsupported-evidence rate          |
| `ai-live-smoke.e2e-spec.ts`    | the real provider — **skipped unless a key is present**     |

Normal CI requires no Anthropic API key, sends no repository or customer
documents, and uses only synthetic fixtures. No confidential manuscripts, ever.

## What Phase 8 deliberately does not do

No rule extraction from guideline files (that is Phase 9). No automatic
Standard creation from AI. No SmartFix, payments, PDF analysis, institutional
approval, certificates, blockchain or OJS integration. No general-purpose
"ask the model" endpoint: every route names a PalCert task with a fixed prompt
and a validated output schema.

## Related

- ADR-0054 … ADR-0060
- [checks.md](checks.md) — the deterministic result this sits beside
- [docx-analysis.md](docx-analysis.md) — the structural model the context is built from
- [rule-engine.md](rule-engine.md) — where `AI_ASSISTED` and `MANUAL` come from
