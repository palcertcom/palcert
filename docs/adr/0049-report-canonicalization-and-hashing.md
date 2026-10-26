# ADR-0049: Reports are canonicalized before they are hashed

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

A report hash is only worth having if two parties who serialize the same report
get the same bytes. `JSON.stringify` does not give that: key order follows
insertion, so a refactor that builds an object differently changes the hash of
a report whose meaning never moved. Phase 15 intends to anchor these hashes
externally, which makes the property load-bearing rather than decorative.

## Decision

**Canonicalization is RFC 8785 (JCS):** object keys sorted by UTF-16 code unit,
no insignificant whitespace, absent and `undefined` members treated alike, array
order preserved.

**No JSON numbers anywhere in the report.** Every numeric value in the report
schema is either an integer or a decimal string, which sidesteps JCS's number
formatting rules entirely and keeps the canonical form identical across
languages. The canonicalizer throws on a fractional or unsafe number rather
than hashing a float whose rendering is runtime-specific.

**Two hashes, because two different questions are asked.**

- `reportHash` covers the complete report record. "Is this the same report?"
  It changes when the check id, the run id or the generation time changes.
- `evaluationHash` covers the inputs' identities and the outcomes, and
  deliberately excludes the check id, the run id, the owner and the timestamp.
  "Did the engine reach the same conclusion?" Re-running the same document
  against the same standard with the same engine is provably identical even
  though it is a different check.

**The canonicalization is versioned.** `reportCanonicalizationVersion` is stored
with every report. If this behaviour ever has to change, it changes under a new
version number and old reports keep verifying against the rules they were
written under. Changing it silently is the one thing that must never happen, so
a committed golden fixture — the report, its canonical bytes and their SHA-256 —
is verified in CI.

**The stored artifact is the canonical bytes.** The API serves exactly what was
hashed, so anyone holding the hash can verify it independently. It is served
through the authenticated API, never from a public bucket and never as a
presigned URL.

## Consequences

- A hash issued today still verifies years from now.
- A canonicalization change is a deliberate, versioned, reviewed act, because
  CI will not let it be anything else.
- The report is language-neutral: codes, typed values, and the rule titles and
  guidance the standard's author wrote in both languages. No sentence in it
  depends on the reader's UI language.
