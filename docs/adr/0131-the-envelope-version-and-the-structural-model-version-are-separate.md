# ADR-0131: The artifact envelope and the structural model version separately

- **Status:** Accepted
- **Date:** 2026-09-19
- **Phase:** 18

## Context

The analysis artifact has carried one version number in two places since Phase
6: `analysisSchemaVersion` at the envelope's top level, and
`structuralModel.analysisSchemaVersion` inside it. The shared schema has always
treated them as two fields. The DOCX analyzer supplied both from one constant,
because while they agreed there was nothing to tell apart.

Phase 18 ends the agreement. The envelope gains an optional `citationAnalysis`
section, gated in both directions: a version 2 envelope must carry it and a
version 1 envelope must not. The structural model did not change at all.

Bumping the shared constant would have made the structural model announce a
change it did not undergo — a second statement, and a false one. Every reader
comparing artifacts across the release would see a structural version move and
go looking for what moved.

## Decision

**The envelope version is its own constant. The structural model keeps its
own, and it stays at 1.**

`ENVELOPE_SCHEMA_VERSION` (2) is what the artifact's top-level field and the
analyzer's identity report. `ANALYSIS_SCHEMA_VERSION` (1) remains the
structural model's, and the SmartFix engine identity keeps reporting it,
because that is what it always meant.

**The envelope version belongs to the analyzer, not to the release.** The API
stamps it on the analysis row from its per-analyzer dispatch table rather than
from a release-wide configuration value, because DOCX and PDF are now on
different envelopes and one shared number would be wrong about one of them — in
a stored record, written before the artifact it describes exists.

**The DOCX analyzer's own version moves with it.** Reuse of a stored analysis
is decided by the analyzer's name and version, never by the envelope version,
so an analyzer that started emitting citation evidence without its version
moving would let an analysis produced before Phase 18 be served to a caller
expecting the section. The caller cannot detect this: a version 1 artifact is a
perfectly valid artifact. The bump is what makes the old analyses incompatible,
which is the correct outcome — they were produced by an analyzer that did not
read citations.

## Consequences

Documents analyzed before this release are re-analyzed on their next check.
That is the intended cost and the reason the version exists.

The API's analyzer table and the engine's constant have to move together, and
the worker enforces it rather than trusting it: an artifact whose analyzer
identity does not match the analysis row is refused rather than stored. A
mismatch is a loud failure at the first analysis, not a quiet one later.

The PDF analyzer is untouched: envelope version 1, no citation section, same
analyzer version. Its artifacts remain byte-identical.
