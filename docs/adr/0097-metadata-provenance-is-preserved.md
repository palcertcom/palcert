# ADR-0097: Both metadata sources are kept, and the chosen one is named

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

A PDF can carry its title twice: once in the XMP packet and once in the
DocumentInfo dictionary. They routinely disagree — a document edited in one tool
and exported by another can keep an old title in one and a new one in the other.

An analyzer has to pick one to answer a rule with. The easy implementation
picks, stores the winner, and discards the loser. The loser is then unavailable
to anyone asking why the report says what it says, and the disagreement — which
is itself a finding, and often the explanation for a puzzling result —
disappears silently.

## Decision

**The structural model keeps both sources, records which was chosen per field,
and raises a warning when they disagree.**

- `metadata.xmp` and `metadata.documentInfo` each hold their own values.
- `metadata.effective` holds the value PalCert will answer with, and
  `metadata.chosenSource` names where each came from. Precedence is XMP first,
  DocumentInfo second — deterministic and documented, not per-document.
- `metadata.conflicts` lists the fields that disagreed, and the analysis raises
  `PDF_METADATA_CONFLICT`.
- Fact provenance carries the chosen source (`from xmp`), so a report citing the
  title says where the title came from.
- The warning names the *fields*, never the values: a warning reaches logs and
  the report UI, and a title is user content (§109). The values live in the
  artifact, which is stored in `palcert-derived`.

## Alternatives considered

**Store only the effective value.** Cheapest, and it makes "why does the report
say this?" unanswerable after the fact.

**Emit two facts and let the rule engine decide.** Two facts for one property
means every rule about metadata has to decide which it means, which is the same
decision made worse by being made in more places.

**Treat a conflict as an analysis failure.** A disagreement is extremely common
and is not the user's fault. Refusing to analyze would be refusing to work on
ordinary documents.

## Consequences

- A conflict is visible rather than silent, and can be explained to a user whose
  report cites a title they thought they had changed.
- The artifact is slightly larger. It is stored once and read by checks.
