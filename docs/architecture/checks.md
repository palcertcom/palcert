# Document checks, results and reports

> Phase 7. The first end-to-end PalCert workflow: a user's document version, an
> organization's published standard version, one analysis, one evaluation, one
> immutable report.

```
DocumentVersion (READY, DOCX or PDF) ─┐
                                ├─►  DocumentCheck  ─►  CheckRun  ─►  CheckReport
StandardVersion (PUBLISHED)    ─┘         │                │              │
                                          │                │              └─ canonical JSON in the derived bucket
                                          │                └─ CheckRuleResult ─► CheckViolation
                                          └─ DocumentAnalysis (Phase 6, reused)
```

## What a check is

A check is a claim about **specific bytes** and **specific rules**. At creation
it captures, immutably:

| Captured                 | Why                                                          |
| ------------------------ | ------------------------------------------------------------ |
| `documentVersionId` + `documentSha256` | the exact draft, provably                       |
| `standardVersionId` + `standardContentHash` | the exact rules, provably                  |
| `documentAnalysisId` (once one exists) | the exact facts the verdict rested on           |
| catalogue labels         | so the check renders without reading the organization's tables |

A trigger refuses to change any of them (ADR-0046). A check never begins
against "the latest" of anything.

## Lifecycle

```
CREATED ──► WAITING_ANALYSIS ──► EVALUATING ──► GENERATING_REPORT ──► COMPLETED
   │               │                  │                 │
   └───────────────┴──────────────────┴─────────────────┴──► FAILED ──(retry)──► EVALUATING
```

`COMPLETED` and `CANCELLED` are terminal. `FAILED` is *settled* but retryable:
a retry starts a **new run**, never a rewrite of the old one, and the failed
run keeps its own record of what went wrong.

Creation validates, captures, pins the source against deletion with a retention
lock, ensures an analysis exists, and hands the work to the Phase 5 outbox.
Nothing heavy happens inside the HTTP request; the response is `202`.

A check whose analysis is still running parks in `WAITING_ANALYSIS` and is woken
by the analysis worker inside the flow that completes the analysis — a durable
hand-off, not a polling loop.

## The evaluation worker

Each step exists to make a specific lie impossible:

1. **Claim** the run atomically. A duplicate delivery is a no-op.
2. **Load the analysis artifact** by its exact object version, and verify the
   bytes against the recorded digest.
3. **Validate the artifact** against the shared JSON Schema. Node never parses
   whatever dictionary happened to arrive.
4. **Load the standard snapshot** and compare its content hash to the one the
   check captured. A mismatch fails closed — never a quiet switch to another
   version.
5. **Evaluate** in the Python engine over HTTP (ADR-0052). There is no second
   evaluator.
6. **Build the report**, validate it against its schema, canonicalize, hash,
   store the artifact.
7. **Persist once**, in a single transaction: rule results, violations, the
   report row, the run's finalization and the check's completion. A crash
   before the commit leaves a retryable run and no partial report.

Failures are classified. Integrity and document failures are **permanent** —
the check fails and the job succeeds, because deciding "this cannot be
evaluated" is a decision. Engine, storage and unknown failures are
**transient** and retried: an outage must never become a compliance verdict.

## Determination and score

Two separate axes — see ADR-0047 for why, and ADR-0048 for the score's
arithmetic and its deliberately narrow scope.

In short: `status` says how far the work got; `determination` says what was
concluded, and only a completed check has one. `INDETERMINATE` means the
evidence could not decide and is never mapped to a failure. The score counts
deterministic rules only, once each, weighted by severity, computed exactly,
and is `null` — not zero — when nothing scorable resolved.

## The report

Immutable, language-neutral, and hashed over its RFC 8785 canonical form
(ADR-0049). It carries every identity needed to reproduce the outcome: the
document version and its digest, the standard version and its content hash, the
analysis and its artifact digest, and the analyzer, engine and orchestrator
versions.

Two hashes: `reportHash` identifies the record, `evaluationHash` identifies the
conclusion independently of which check produced it or when.

The stored artifact is exactly the bytes that were hashed, served through the
authenticated API — never a public URL, never a presigned link, never a raw
object key in a response. Reading a report never re-runs the rule engine.

## Isolation

All five tables are `USER_SCOPED` (ADR-0051). The organization that publishes a
standard sees nothing about checks against it. The catalogue a student chooses
from is served by narrow `SECURITY DEFINER` functions rather than by loosening
any tenant policy (ADR-0050), and a standard is exposed to it only by a
deliberate, audited act.

## Retention

- A check holds a `CHECK` retention lock on its document version, so the source
  cannot be purged while a report references it.
- A completed run holds a `REPORT` lock, so the analysis artifact its report
  cites survives too.
- A purge of an unlocked version now deletes its derived analysis artifacts as
  well as its source; the analysis *row* survives, so a report can still name
  the analyzer that produced its evidence.

## Limits

One place for every number (`CHECK_*` in the environment schema): stored
violations per rule, returned violations per rule, page size. Every cap is
disclosed in the data and in words (ADR-0053).

## Formats

Phase 7 checked DOCX only. Phase 13 added PDF: the same check, the same rule
engine and the same report, fed by a second analyzer chosen from the version's
detected format. What differs is what each format can answer — a PDF states its
page count and stores no margins; a DOCX is the reverse — so a standard's
coverage is previewed before payment, and a standard a format can answer
nothing of is refused rather than sold. See
[`pdf-analysis.md`](pdf-analysis.md).

## What Phase 7 does not do

No AI of any kind — no Claude, no OpenAI, no Gemini, no AI verdict. No SmartFix,
no payments, no institutional submission, no university approval, no
certificates. A check is a formatting check against a published standard, and
the product says so on every page that shows a result.

> Phase 11 made checks paid, Phase 12 added SmartFix for DOCX, and Phase 13
> added PDF analysis. PDF remains an inspection format: there is no PDF
> SmartFix ([ADR-0092](../adr/0092-pdf-is-an-inspection-format-not-a-smartfix-format.md)).
