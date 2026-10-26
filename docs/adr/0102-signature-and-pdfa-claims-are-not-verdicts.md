# ADR-0102: A signature field and a PDF/A claim are reported as presence, never as validity

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

Two things in a PDF invite PalCert to make a claim it cannot support.

A **signature field** looks like an assertion that the document is signed. It is
a field. Whether the signature is cryptographically valid, whether the signing
certificate chains to a trusted root, whether it has been revoked, and whether
the signed byte range actually covers the document are four separate questions
requiring a trust store, a revocation check, and a byte-range verification
PalCert does not perform. A field can be present and empty, present and
tampered, or present and signed by anyone at all.

A **PDF/A claim** is a `pdfaid:part` value in the XMP packet saying "this
document is PDF/A-2b". Any tool can write it. Actual PDF/A conformance is a
validation against a specification with hundreds of clauses — font embedding,
colour spaces, transparency, metadata consistency — which PalCert does not run.

In both cases the difference between what the document says about itself and
what is true is precisely what a compliance product must not blur.

## Decision

**PalCert reports presence and provenance; it never reports validity.**

- `signatureFieldCount` is a count. There is no `signatureValid` fact, no
  `verified`, and no `trusted` anywhere in the artifact, and the test suite
  asserts those strings do not appear.
- `claimedPdfAPart` and `claimedPdfAConformance` are named for what they are:
  claims the document makes about itself. There is no `pdfaCompliant` property.
- The report UI presents both as observations with that framing, in English and
  Arabic, rather than as green ticks.

## Alternatives considered

**Validate signatures.** A real feature with a real trust-store dependency and
a real operational burden (revocation, root updates). It would be a phase of its
own, and "we check signatures" is a claim PalCert should only make once it is
completely true.

**Repeat the PDF/A claim as a finding, labelled "declared".** The label is one
word; the finding is a row in a compliance report. Users read rows.

**Run a PDF/A validator.** veraPDF exists and is a substantial dependency with
its own licence review, its own failure modes, and a scope larger than anything
Phase 13 needs.

## Consequences

- A user with a signed thesis sees "1 signature field present" and no claim
  about it, which is the truth.
- PalCert never tells an institution a document is PDF/A when it merely says so.
- Both remain available as honest inputs to a later capability that does verify.
