# ADR-0002: Hybrid deterministic + AI compliance architecture

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

PalCert issues certificates that institutions and journals rely on. A
compliance verdict must be reproducible, explainable and defensible. Large
language models are non-deterministic, can hallucinate measurements, and cannot
be audited line by line. At the same time, some requirements ("does this
manuscript contain a conflict-of-interest declaration?") genuinely need semantic
understanding.

## Decision

Split responsibility permanently:

**Deterministic Document Engine + Rule Engine** own everything objectively
measurable — page size, margins, fonts, sizes, spacing, indentation, styles,
headings, numbering, headers/footers, page numbers, captions, tables, section
properties — and own the **final compliance score**.

**AI Engine** owns semantic work only — rule extraction from guidelines,
section identification, ambiguous requirement interpretation, reference
analysis, declaration detection, anonymization problems, finding explanations
and report narrative.

Two hard constraints:

1. The AI must never calculate or influence the compliance score.
2. The AI explanation layer may never alter a machine finding (§19).

The system must never ask a model "what score should this document receive?"

## Alternatives considered

- **AI-only compliance.** Rejected: non-reproducible, unauditable, and
  unacceptable as the basis of a certificate.
- **Deterministic-only.** Rejected: cannot extract rules from prose guidelines
  or detect missing declarations, which are core product value.

## Consequences

- Deterministic findings carry no probabilistic confidence; AI findings do.
- The machine report and the narrative are persisted separately.
- An AI outage degrades explanations but must still allow a check to complete
  and score (tested in Phase 8).
- Golden document tests can assert exact deterministic results forever.
