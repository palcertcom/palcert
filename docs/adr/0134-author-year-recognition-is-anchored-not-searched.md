# ADR-0134: Author-year recognition is anchored, not searched

- **Status:** Accepted
- **Date:** 2026-09-19
- **Phase:** 18

## Context

Checkpoint 10 gave PalCert one heuristic citation family: a bracketed numeric
marker. That covers engineering theses and leaves out most of the humanities
and social sciences, whose references are author-year and whose bibliographies
carry no labels at all — they are ordered alphabetically, so the numeric region
detector saw nothing in them.

Adding author-year is not the same problem as adding another number format.
`[12]` is punctuation nobody writes by accident. A capitalized word beside a
four-digit number inside parentheses is ordinary English:

* `(March, 2020)` is a date;
* `(Copyright, 2019)` is a notice;
* `(Smith v. Jones, 2020)` is a lawsuit;
* `(Python 3.9)`, `(Ubuntu 2004)` are dependencies;
* `(n = 42)`, `(1990–2020)`, `(3.14)` are values.

A permissive detector would fill an artifact with citations the document never
made. Because heuristic evidence is quarantined from facts (ADR-0133) none of
that could change a verdict — but an evidence panel renders the artifact, and a
reviewer reading invented citations has been misled just the same.

## Decision

**The grammar is anchored end to end rather than searching.** A parenthesised
group must parse completely, from its first character to its last, or it is not
a citation. There is no "find an author somewhere in here". A group with one
segment PalCert cannot read is rejected **whole** rather than harvested for the
part that looked familiar, so `(see Smith, 2020)` and `(Smith, 2020; personal
communication)` yield nothing at all.

On top of the anchor sit two closed lists: words that are never an author
(months, weekdays, seasons, `Copyright`, `Version`, `Figure`, `Table`, …) and
lawsuit syntax (`v.`, `vs.`). Both are finite and every entry earns its place
from a false positive a real document produces.

**Matching is exact identity.** The case-folded first surname plus the year
token, compared verbatim — no stemming, no transliteration, no diacritic
stripping, no initial-only fallback, no edit distance. Each of those turns a
comparison into a judgement, and a wrong judgement points a citation at the
wrong work while looking exactly like a right one.

**Author shape breaks a tie and never creates one.** When an identity already
names more than one entry, the citation's shape (`Smith` vs `Smith & Jones` vs
`Smith et al.`) may narrow it to one. It can only ever *remove* candidates, so
two solo `Smith 2020` entries stay two candidates and the citation stays
AMBIGUOUS. Confidence is not consulted anywhere in the linker.

**"Nothing to search" is NOT_ATTEMPTED, not UNRESOLVED.** A `(Smith, 2020)` in
the prose of a thesis whose reference list is numbered has no author-year
population to be looked up in. "Looked and found nothing" would be a claim
PalCert cannot make, so no link row is written.

**Only the fields matching needs are parsed.** Surnames and the year. Title,
journal, volume, issue, pages, publisher and DOI are absent rather than
guessed, and every author token carries the surname as written so the parse
stays traceable to the entry's own text.

**No new parse method was added.** `parseMethod` names how an object was
*identified* — `REGION_MEMBERSHIP` for an entry, `AUTHOR_DATE_PATTERN` for a
marker, both already in their vocabularies — and `parseStatus` separately says
how much of its content was read. A numbered entry stays `UNPARSED`; an
author-year entry becomes `PARTIAL`. There was no gap to report.

**Arabic-script author names are not recognized.** The Latin grammar's safety
rests almost entirely on the leading capital, which is the only deterministic
signal a text layer offers that separates a name from an ordinary word. Arabic
has no case. Recognizing "any Arabic word followed by a parenthesised year"
would manufacture citations out of prose, and a name that *was* recognized
could not be matched reliably either — Arabic surname normalization (`ال`,
`ابن`/`بن`, tāʾ marbūṭa, hamza variants) is a transliteration problem, not a
case-folding one. Arabic *punctuation* is accepted inside the grammar, so a
bilingual `(Smith، ٢٠٢٠)` is read; Arabic numeric discovery is unchanged.

## Alternatives considered

**Detect Arabic author-year citations without matching them.** Sanctioned by
the checkpoint as a fallback, and rejected: detection alone still writes false
citations into the artifact, and the false-positive rate without a case signal
is the whole problem rather than a detail of matching.

**Require a matching reference before emitting a citation.** It would remove
almost every false positive at once. Rejected because it also removes
`UNRESOLVED`, which is real and useful evidence: a citation to a work the
document never lists is exactly the kind of thing a reviewer wants to see.

**Score candidates and take the best.** Rejected on the same ground as every
earlier Phase 18 checkpoint: a tuned number choosing between two works records
a coin toss as a citation's target.

## Consequences

The PDF analyzer moves to `7.0.0`; a document whose reference list is
alphabetical now carries a citation graph where `6.0.0` carried an empty one.
DOCX stays at `4`. No contract, schema or registry changed, and no public
property was added — the three projection gates from ADR-0133 hold unchanged,
and an author-year citation that resolves perfectly still emits no fact.

The confidence policy gained two groups and its grouping became explicit rather
than derived from a name prefix, because the new signals do not share a first
word with the ones they sit beside and a spelling-based grouping would have
merged them into a group summing to more than 1.

What stays out of reach: fuzzy matching, Arabic-script names, reference entries
written without initials, unbracketed numbered lists, and author-year matching
against a numbered bibliography whose entries are identified but not parsed.
Each is recorded in `docs/architecture/citations.md` rather than approximated.
