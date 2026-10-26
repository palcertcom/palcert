# ADR-0039: PalCert reads OOXML directly, and versions the analyzer that does

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

The obvious way to read a DOCX is `python-docx`. It is mature, it is pleasant,
and it would have PalCert extracting paragraphs within an afternoon.

It also cannot answer the questions PalCert actually asks. A compliance rule
says "body text must be 12 pt Times New Roman". Answering that requires the
*effective* formatting of every run, which means `docDefaults`, the paragraph
style chain, the character style chain, direct formatting, OOXML toggle
semantics, theme font references, and the complex-script channel for Arabic.
High-level libraries deliberately hide most of that: they expose what a
document *declares*, not what it *has*. A paragraph that declares nothing and
inherits 14 pt bold from its style reads as "no formatting" through that lens,
and PalCert would tell a student their correctly formatted thesis has no font.

## Decision

**The analyzer parses OOXML itself**, from the package relationships down.
`python-docx` is not a dependency. The analyzer understands `docDefaults`,
style inheritance, theme fonts, numbering, section properties, complex-script
formatting, headers and footers, field codes and tracked revisions, because
each of those changes an answer PalCert gives.

**The analyzer carries its own semantic version** (`palcert-docx` version
`1`), separate from the application version and from any git commit. A change
that alters what is extracted is an analyzer-version decision, because a
stored analysis is interpreted through that version for ever: a check recorded
in March must still be explicable in December.

## Alternatives considered

- **`python-docx` plus targeted XML access.** Rejected: two models of the same
  document, disagreeing at exactly the edges that matter.
- **Word or LibreOffice automation.** Rejected outright (§17). It cannot run
  headlessly in PalCert's infrastructure, it is not deterministic, and it
  would put a full office suite in the path of untrusted user uploads.
- **Version the analyzer by git commit.** Rejected: a commit identifies a
  build, not a behaviour. Ninety unrelated deployments should not make ninety
  analyzer versions.

## Consequences

- Phase 6 owns roughly 4 000 lines of OOXML reading, covered by a 50-fixture
  golden corpus built from raw XML so every expectation is reviewable.
- Unsupported OOXML is visible rather than silent: the analyzer warns and
  degrades coverage instead of returning a confident partial answer.
- Adding a property means adding it to the property catalogue, which is what
  keeps the Rule Builder honest about what DOCX can prove.
