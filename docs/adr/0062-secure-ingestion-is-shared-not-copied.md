# ADR-0062: Organization source uploads reuse the Phase 5 ingestion pipeline verbatim

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 9

## Context

Phase 5 built a careful path for untrusted bytes: a presigned upload into a
quarantine bucket, signature-based format detection that ignores the declared
MIME type and the extension, DOCX archive safety checks (compression ratios,
entry counts, path traversal, macros), PDF structure checks, a SHA-256 computed
by PalCert rather than trusted from the client, a malware scan as a gate, and
only then an immutable promotion into the clean bucket.

Phase 9 needs exactly that for guideline and template uploads. The tempting
shortcuts were both bad: write a second, simpler path because "these come from
staff, not students", or copy the pipeline and adjust it.

A guideline PDF is not more trustworthy than a thesis. It arrives over the same
internet, from a browser, and it is going to be parsed by the same libraries.
"Staff uploaded it" is not a security property.

## Decision

`SourceIngestJobHandler` calls the **same** `IngestPipeline` as
`DocumentIngestJobHandler`, with the same checks in the same order and no
Phase 9 exemptions. Nothing about the pipeline was weakened, and nothing was
branched on source kind.

Where the two paths genuinely differ — the storage key prefix, the tenancy scope
used to write results, the status vocabulary — the difference lives in the
caller, not in the pipeline. `IngestInput` was narrowed to the fields the
pipeline actually uses, so it is source-agnostic rather than document-shaped.

Storage keys carry no organization name, no email address, no original filename
and no standard title: `organizations/{organizationId}/standards/{versionId}/sources/{sourceId}/source`.

## Alternatives considered

**A lighter path for organization uploads.** Rejected. It would have been the
weakest link and the least tested one.

**Copy-and-adapt the pipeline.** Rejected. Two copies of security logic means
one of them is out of date, and nobody knows which.

## Consequences

- A macro-bearing guideline, an encrypted PDF and a zip bomb are all rejected
  before anything reads them, by code that has been exercised since Phase 5.
- A fix to the ingestion pipeline benefits both paths at once.
- The e2e suites assert the rejection codes directly, so a future refactor that
  quietly bypassed the pipeline for sources would fail.
