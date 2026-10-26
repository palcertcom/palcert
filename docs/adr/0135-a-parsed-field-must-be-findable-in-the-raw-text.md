# ADR-0135: A parsed bibliographic field must be findable in the raw text

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 18

## Context

Checkpoints 10 and 11 taught PalCert to *find* reference entries in an
untagged PDF. Checkpoint 12 reads what is inside one: title, container title,
DOI, URL, alongside the author and year already parsed.

This is a different kind of risk from discovery. A false citation is visibly
odd — a reviewer sees a marker where none exists. A false *field* is not: a
plausible title attached to a real entry, a DOI with its punctuation tidied
up, a journal name inferred from position all look exactly like correct
parses. An evidence panel renders them as things PalCert read out of the
document, and nothing on the page distinguishes a value that was read from one
that was assembled.

Bibliographic text is also genuinely hard to segment. `Water rights in the
U.S. basin. Journal of Policy.` splits at the first sentence break into
`Water rights in the U.S` — mangled, and still title-shaped. A segment after
the title may be a journal, a publisher, a series, a conference or a thesis
institution, and position alone does not say which. A DOI suffix may
legitimately end in `.`, `,`, `;`, `)` or `]`, so the trailing character of
`10.1234/abc.` cannot be classified from the text alone.

## Decision

**The raw text is the source of truth, and a field is emitted only when it is
an exact substring of it.** Every value — title, container, year, each
surname, each identifier's `raw` — can be located in `rawText` with a
substring test, and a test sweeps every entry to prove it. A `normalized`
identifier is a case fold of its own `raw`, so it stays checkable through the
value it came from. Entry text is bounded *before* parsing rather than after,
so a long entry loses the fields past the bound instead of carrying ones no
reader could verify.

**A field whose grammar is uncertain is absent.** A title candidate containing
a period is refused outright: the cost is the titles that legitimately contain
one, and the purchase is never publishing a mangled one. A container title is
claimed only when a `, 12(3), 45-67` shape confirms the segment is a journal
article's, because that shape is a journal's and nothing else's. Volume,
issue, pages, publisher and article number have no grammar of their own and
are not emitted at all — the volume-issue-pages shape is parsed purely as the
container's confirming evidence.

**An identifier whose end cannot be determined carries no identity.** The
evidence is recorded with `boundaryStatus: AMBIGUOUS` and **no** `normalized`
value, so nothing can ever match on it. A `doi:` label followed by something
that is not a DOI is recorded with `syntaxStatus: INVALID` and likewise no
identity — the document said "DOI" and wrote something else, which is a real
observation worth keeping.

**Normalization is offline and identity-preserving.** DOIs fold to lower case
(case-insensitive for comparison) and lose a resolver prefix; percent-encoding
is left alone, because `%2F` and `/` are different characters in a suffix.
URLs fold scheme and host and keep path, query and fragment exactly as
written. Nothing is resolved, expanded, followed or stripped, and
`syntaxStatus` is a shape check that never says the work exists.

**`DOI_IDENTITY` stays unused.** The method requires the same normalized DOI
on both sides, and `CitationOccurrence` is a closed object with no identifier
field: an in-text citation cannot carry a DOI at all. Deriving one from nearby
prose would satisfy the letter of the method and destroy its meaning, so the
method stays unused and the contract gap is reported rather than worked
around.

**Enriching an entry is not the same decision as making it matchable.** A
numbered entry with a clear author-year structure is now parsed into
bibliographic fields. It does **not** become a candidate for an author-year
citation. Checkpoint 11 reports `NOT_ATTEMPTED` for an author-year marker in a
numbered thesis — there is no author-year population to look in — and letting
enrichment change that would report `UNRESOLVED`: an attempt PalCert never
made, presented as one that failed.

## Alternatives considered

**Emit a best-effort title and let the confidence carry the doubt.** Rejected:
confidence is a property of the *entry*, not of each field, and a per-field
score would be a number nobody could act on. A field is either defensible or
absent.

**Strip trailing punctuation from every DOI and move on.** It would be right
almost always. Rejected because "almost always" is what a silent wrong
identity is made of, and the contract already says PalCert does not guess
here. Style guides that forbid a period after a DOI make the common case
unambiguous anyway.

**Let parsed numbered entries feed author-year matching.** It is probably the
right end state and it is a change to matching semantics, which this
checkpoint was told not to make implicitly. It is gated behind
`matchable_by_author_year` and a dedicated test, ready to be enabled as its
own decision.

## Consequences

The PDF analyzer moves to `8.0.0`; entries that carried only an identity now
carry structured fields. DOCX stays at `4`. No contract, schema or registry
changed: `CitationIdentifier` already had exactly the fields this needs —
`intentEvidence`, `boundaryStatus`, `syntaxStatus` — and reading them as
written is what shaped the decisions above.

A reference entry is `PARTIAL` whenever anything was read out of it and never
`PARSED`, because the contract does not define what a fully parsed entry
requires. `PARSED` remains available for a checkpoint that defines it.

The recorded contract gap is `CitationOccurrence` having no identifier field.
Closing it would let a citation that explicitly carries a DOI — rare in prose,
ordinary in a footnote-style reference — participate in `DOI_IDENTITY`
matching. Until then the method has no citation-side evidence to rest on.
