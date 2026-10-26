# ADR-0045: The analysis view is FINAL, and says so

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

A manuscript under review carries tracked changes. The same file therefore
contains at least two documents: the one before the edits and the one after.
Word shows either, depending on a setting nobody records in the file.

A word count, a font check and a heading list all give different answers
depending on which view is taken. Choosing silently would make PalCert's
numbers unreproducible and its verdicts arbitrary.

## Decision

**The default analysis view is FINAL**, stated once and applied everywhere:

| Markup | In the FINAL view |
| --- | --- |
| `w:ins` | included — it is part of the document |
| `w:del` | excluded — `w:delText` is read for accounting only |
| `w:moveTo` | included |
| `w:moveFrom` | excluded |

Hidden text (`w:vanish`, `w:webHidden`) is kept in the structural model — the
document does contain it — but excluded from word counts and from the visible
text a fact describes (§58).

Formatting revisions (`w:pPrChange`, `w:rPrChange`, `w:tblPrChange`) record
what the formatting *used to be*. The FINAL view evaluates current effective
formatting and never applies historical properties.

**Presence is reported separately from content.** `trackedChangesPresent`,
`trackedInsertionCount`, `trackedDeletionCount` and
`trackedFormattingChangesPresent` are facts in their own right, so a journal
can require "no unresolved tracked changes" without PalCert needing to take a
position on what the text should be.

## Alternatives considered

- **The ORIGINAL view.** Rejected: nobody submits the original.
- **Both views in one artifact.** Rejected for now: it doubles the artifact and
  no rule needs it. The structural model records each node's revision state, so
  a second view can be derived later without re-reading the document.
- **Refuse documents with tracked changes.** Rejected: detecting them is
  exactly the service some journals want, and refusing would remove the ability
  to report on them.

## Consequences

- Word counts are defined over the FINAL view, and that is part of the
  documented word-count definition (§59).
- Changing this view would change every count PalCert has ever produced, so it
  is an analyzer-version decision, not a configuration option.
- A golden fixture asserts that inserted text counts, deleted text does not,
  and both are reported as present.
