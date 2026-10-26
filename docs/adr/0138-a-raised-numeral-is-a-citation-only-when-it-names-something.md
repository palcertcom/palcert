# ADR-0138: A raised numeral is a citation only when it names something

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 18

## Context

Vancouver and Nature styles set a citation as a raised numeral — `…contested³`,
`…both³,⁵,⁷`, `…a range⁴⁻⁶`. Checkpoints 10 to 13 could not see any of it,
because every detector they have reads *text*, and a raised numeral is plain
digits: as characters it is indistinguishable from an exponent, a footnote
marker, an ordinal or a page number.

What distinguishes it is geometry, which PalCert already has — each span
carries its own font size and its own box. The obvious implementation is
therefore "a smaller span lifted above the baseline is a citation", and that
implementation is wrong in a way that would not show up in testing. `x²` is a
smaller digit raised above a body span. So is `y³`. So is every exponent in
every equation in every engineering document PalCert will ever be given.

The checkpoint is explicit about this: *do not classify a number as a citation
merely because its font size is smaller.*

## Decision

**Geometry establishes that a numeral is raised, and never that it is a
citation.** Three geometric conditions gate a marker, and all three are strict
inequalities or interval overlap — no point distance, no font-size ratio, no
tuned gap. A span is raised when its bottom is strictly above a body span's,
small when its size is strictly smaller, and on the same visual line when their
vertical extents overlap. A tuned number is exactly what would make this
detector quietly wrong on the next document, so there is not one.

**A raised numeral becomes a citation only when it names a reference entry that
exists in the region serving that part of the document.** The reference it
points at is the only reason to read a raised numeral as a citation in the
first place; a marker matching nothing is not a weak citation but not a
citation at all, and is reported as nothing.

**Text the marker is attached to can still reject it.** A marker attached to a
lone letter reads as a variable — which is what an exponent is attached to —
and is refused even when it happens to name an entry.

The same rule shapes the parenthesised Vancouver form, `(3)` and `(3,5,7)`,
whose look-alikes are equation numbers, list markers and function subscripts.
Its precondition is the document's own style: the form is read only in a
document that numbers its own reference list *without* brackets. A document
whose bibliography reads `[7] Smith, J.` writes its markers `[7]`, so `(7)`
there is something else, and reading it would be reading against the author's
established style. That precondition is a fact about the file, not a
preference.

## Consequences

Chemical notation is rejected before any textual check runs, because `H₂O` sets
the 2 *below* the baseline and fails the raised test itself. Exponents are
rejected twice over. Footnote markers and ordinals are rejected by naming no
entry — which also means a document whose footnotes happen to be numbered
inside the range of its bibliography can still produce a false positive, and
that residual gap is recorded rather than papered over.

The cost is recall, and it is accepted on purpose. A raised citation in a
document whose reference list PalCert could not recognize is invisible, because
there is no population to check the number against. The checkpoint's own
instruction settles it: prefer missing a citation over fabricating one.
