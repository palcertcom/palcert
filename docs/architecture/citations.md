# Citations and references

Phase 18. PalCert reads what a document's citations and reference list *are*
and reports it as evidence. It does not write bibliographies, does not judge
sources, and does not resolve anything over the network.

This page describes Phase 18 through Checkpoint 13: the `citationAnalysis`
producers for DOCX and PDF, the conservative heuristic layer that recovers
numeric and author-year citation structure from untagged PDFs and parses
bibliographic fields out of what it found, the projection of exact evidence
into facts, and the public properties a rule author can write against. The contracts are
`contracts/schemas/analysis-artifact.schema.json`,
`contracts/registries/citation-projection.json` and
`contracts/registries/document-property-support.json`.

## Evidence is not authority

`citationAnalysis` is a section of the analysis artifact. **The rule engine
never reads it.** An observation becomes something that can decide a
compliance verdict only by being projected into a `DocumentFactSet` fact
through the Phase 18 projector allow-list, which holds five properties:

| Scope | Property | Value | Coverage policy | Formats |
| --- | --- | --- | --- | --- |
| DOCUMENT | `nativeCitationCount` | NUMBER, COUNT | `COMPLETE_OR_UNAVAILABLE` | DOCX |
| DOCUMENT | `nativeBibliographySourceCount` | NUMBER, COUNT | `COMPLETE_OR_UNAVAILABLE` | DOCX |
| ELEMENT / CITATION | `nativeSourceResolved` | BOOLEAN, unitless | `COMPLETE_PARTIAL_OR_UNAVAILABLE` | DOCX |
| DOCUMENT | `referenceRegionPresent` | BOOLEAN, unitless | `POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE` | DOCX, PDF |
| ELEMENT / CITATION | `citationTargetResolved` | BOOLEAN, unitless | `COMPLETE_PARTIAL_OR_UNAVAILABLE` | PDF |

Which formats may project a row is part of what the registry authorizes, so
the format list is read off the row too. Support is derived per format from
what that format's evidence can actually prove — never copied across from
another format because the two properties sound alike.

Checkpoint 4 ships the projector. It reads the registry rather than paraphrasing
it: the value kind and the unit of every fact come out of the row, never out of
the property's name. Everything else in the section stays advisory — tags,
rendered entries, identifiers, link candidates and every `observed*` counter
reach no rule at all.

The separation matters because of how the deterministic engine aggregates: a
failed condition produces FAIL *before* coverage is consulted. `PARTIAL`
coverage therefore prevents a false pass and does **not** prevent a false
failure. A partial count is a wrong value, not a missing one, so the two count
properties may be emitted under `COMPLETE` coverage or not at all.

### What the projector will not say

| Evidence | Fact | Why |
| --- | --- | --- |
| A link PalCert could not choose (`AMBIGUOUS`) | none | `true` asserts a resolution it refused to make; `false` says the citation does not resolve when it may resolve to either candidate |
| A citation nobody tried to link (`NOT_ATTEMPTED`) | none | there was no exact source set to look in, which is not a failed lookup |
| A count from a document with an unreadable story | none | a lower bound wearing the name of an exact number |
| No reference region found | none | absence of proof is not proof of absence — a hand-typed list is invisible to the test |
| Anything about a rendered reference entry | none | its identity is established by classification, and coverage cannot repair a wrong element identity |

The coverage translation is where a policy becomes a guarantee. Under
`COMPLETE_OR_UNAVAILABLE`, an advisory `PARTIAL` domain becomes `UNAVAILABLE`
in the fact set, so the count is withheld rather than published with a caveat
the engine would not honour.

One rule in that table is less obvious than it looks. The two per-citation
resolution properties cover *each* citation, and an ambiguous one produces no
fact — so a rule like "every citation resolves" would read only the citations
PalCert was sure about and pass on those. The element coverage is therefore
`COMPLETE` only when every citation in scope got a value, and `PARTIAL`
otherwise, which turns that false pass into INDETERMINATE.

### Two resolution properties, two different questions

`nativeSourceResolved` and `citationTargetResolved` are not the same property
under two names, and neither is a generalization of the other.

| Property | The question it asks | Answerable where |
| --- | --- | --- |
| `nativeSourceResolved` | does this Word citation's tag match a record in the document's Word bibliography source store? | DOCX only |
| `citationTargetResolved` | does this declared citation resolve to exactly one declared reference entry in the same analyzed document? | PDF only |

The support is mirror-imaged because the graphs are. A Word citation's link
targets a `BibliographySource` — a record in a custom XML part — and a
bibliography source record is *not* a reference entry: it is the data Word
renders an entry from, and Word may render none at all. A tagged PDF has no
source records and its citation links target a declared `/BibEntry`, which is
a reference entry.

So DOCX declares `citationTargetResolved` UNSUPPORTED rather than answering it
from the source store, which would silently redefine the question; and PDF
declares `nativeSourceResolved` UNSUPPORTED rather than answering it from the
entry graph, which would silently redefine the other. A rule about either is
INDETERMINATE on the format that cannot answer it — not a confident `false`.

`citationTargetResolved` is defined without reference to Word tags, source
stores, PDF destinations, numeric labels or native storage. Nothing stops a
future format answering it; nothing about it is format-specific except which
formats can prove it today.

## What the producer reads

Only what Word stores explicitly.

**`CITATION` fields.** Collected during the one structural walk, so each
citation carries the same node id and story as every other finding, and the
story domain is whatever the walk decided it was — an even-page header the
document never uses is not walked, so a citation in it is not counted. The
domain is the main document, text boxes, headers, footers, footnotes and
endnotes. Comments are excluded: a citation somebody suggested in a comment is
not one the document makes.

The analyzer's view is FINAL, so a citation inside a `w:del` is not in the
document and is not counted. This matters more here than elsewhere, because
the native citation count is the one number in this section that is meant to be
exact.

**The bibliography source store**, found by its root element. See
[ADR-0130](../adr/0130-the-bibliography-store-is-found-by-its-root-element.md):
there is no bibliography relationship type, and `customXml/item1.xml` is a
convention rather than a location.

**A `BIBLIOGRAPHY` field's rendered result.** The paragraphs Word wrote between
the field's `separate` and `end` characters are the reference list itself. That
makes them exact evidence of *where* the region is, and it does not make them
exact evidence of what each entry means: the text is whatever the citation
style produced, so nothing is parsed out of it and `parseStatus` says
`UNPARSED`.

## Linking

One method, `NATIVE_TAG`, and one rule: the tag in the field instruction and
the tag on a source record are the same string or they are not.

| Situation | Link row | Citation's status |
| --- | --- | --- |
| Exactly one source has the tag | `LINKED`, names the target | `LINKED` |
| Two or more share the tag | `AMBIGUOUS`, names every candidate | `AMBIGUOUS` |
| No source has the tag | `UNRESOLVED`, names the method tried | `UNRESOLVED` |
| The citation names no tag | none | `NOT_ATTEMPTED` |
| The source set is not exact | none | `NOT_ATTEMPTED` |

There is no fuzzy method, no similarity score and no AI. A link row exists only
when linking was attempted, which is what keeps "we looked and found nothing"
distinguishable from "there was nothing exact to look in".

A native citation links to a Word **source record**, never to a rendered
reference entry. The two are different things — a source may be uncited or
unrendered, a rendered entry may have no source — and matching one to the other
would mean parsing style-generated text, which is exactly the guesswork this
phase refuses.

## Identifiers

Read from named elements in the source store, never by scanning prose. Two
properties follow from that, and both are why prose scanning is deferred:

* **the boundary is never ambiguous.** A DOI read out of a sentence may end in
  `.`, `,`, `;`, `)` or `]` that is either part of the DOI or the sentence's
  punctuation, and PalCert does not guess. A DOI that arrived in a `b:DOI`
  element ends where the element ends.
* **the intent is explicit.** Word labelled the field; a permissive pattern
  match over text would only be a candidate.

A DOI written as a resolver URL is normalized to its core, because that is the
form the Phase 4 matcher recognizes; the raw form is kept so the normalization
is auditable. Word's single untyped `StandardNumber` field becomes an ISBN or
an ISSN only when the value's shape decides unambiguously, and otherwise
becomes no identifier at all.

## Coverage

Six advisory domains, reported per analysis. They explain the *artifact* and
are **not** a substitute for `DocumentFactSet` coverage, which remains the only
thing the rule engine consults.

| Domain | Checkpoint 3 |
| --- | --- |
| `NATIVE_CITATIONS` | `COMPLETE`, or `PARTIAL` if a story part was unreadable or a limit truncated |
| `NATIVE_BIBLIOGRAPHY_SOURCES` | `COMPLETE` when exact or proven absent; `UNAVAILABLE` otherwise |
| `NATIVE_SOURCE_RESOLUTION` | needs both halves; `PARTIAL` when source tags repeat |
| `SEMANTIC_CITATIONS` | `UNAVAILABLE` / `NOT_IMPLEMENTED` |
| `SEMANTIC_REFERENCE_ENTRIES` | `UNAVAILABLE` / `NOT_IMPLEMENTED` |
| `REFERENCE_REGION` | `COMPLETE` when a `BIBLIOGRAPHY` field proves one; `UNAVAILABLE` otherwise |

Reference-region presence is positive-only on purpose. A reference list
somebody typed by hand is invisible to this test, so its absence proves
nothing — and a domain that answered "no region" would let a rule fail a
document for a list PalCert merely did not find.

## Writing a rule about a citation

The four properties are declared in `contracts/registries/document-property-support.json`,
which is what the pre-payment compatibility preview reads. They are `EXACT` for
DOCX and `UNSUPPORTED` for PDF, so a citation standard previews as fully
checkable for a Word document and as answering nothing for a PDF — which is the
truth, and is how a user finds out before paying.

`nativeSourceResolved` carries `elementTypes: ["CITATION"]`, a field registry
version 2 adds. Without it, an ELEMENT-scoped row reads as applying to every
element type, and the neighbouring `REFERENCE_ENTRY` carries no properties at
all — so a rule author could reasonably write a rule that no analyzer will ever
answer.

Four descriptions of the same four properties now exist: the projection
registry, the DOCX fact catalogue, the public support registry and the fact
schema's own unit and element-type vocabularies. Each one can be edited alone,
so they are held to each other by contract tests in both runtimes. A unit in one
and not another would be a fact measured in something no rule can compare.

Nothing else is discoverable. A link target, a candidate list, the method that
found them, a DOI, a rendered entry's text, a heuristic confidence and every
`observed*` counter are absent from the registry, so `supportFor` answers
`UNSUPPORTED` for each — a rule may still name one, and the preview tells the
author it will never be answered.

## Integrity

The section is validated as part of the ordinary artifact contract, in both
runtimes: the JSON Schema, then the citation graph's own consistency — that a
link names a citation that exists, that a declared count matches what is
there, that a citation's `resolutionStatus` agrees with its own link rows.
An artifact that fails is a failed analysis, not a stored record of one.

## Privacy

A citation tag is a key somebody typed into Word's source manager, and the
structural model is rendered into the artifact wholesale — so the tag is kept
out of the structural model and reaches the artifact only inside
`citationAnalysis`, where the contract bounds its length. No part name, no
relationship id and no raw custom XML is carried: that a record came from the
source store is the provenance that matters, and the rest is package detail
that would only widen what an artifact discloses.

## PDF: what a declaration proves

A PDF stores glyphs and rectangles. It stores a citation only when the author
tagged one, and the tagged-PDF structure namespace has the two types that
matter: `/Reference` is "a citation to content elsewhere in the document" and
`/BibEntry` is "a reference identifying the external source of some cited
content" (ISO 32000-2 14.8.4.3). Those declarations are the only citation
evidence the PDF analyzer reads.

Evidence is bound at **span** level, not line level. A line is PalCert's own
grouping of spans sharing a baseline, so a citation marker at the end of a
sentence lands on the same line as the sentence; binding by line would report
the whole sentence as the citation and swallow the label typeset beside a
reference entry. A span carries exactly one marked-content id — the one the
author stamped on it — so span binding reports the element that was declared.

Two exact link methods, and both require the author's declaration at each end.

### `NUMERIC_LABEL`

Requires both sides to carry a declared label:

| Side | Where the label comes from |
| --- | --- |
| Reference entry | a `/Lbl` child, or a `/Lbl` under the `/LI` the entry sits in |
| Citation | a `/Lbl` as above, or the element's own content when it is *entirely* a number |

The normalizer accepts "12", "[12]" and "12." and nothing else — "12a",
"12-14" and "Smith et al. (2020)" carry no label rather than a guessed one.
Two declared labels normalizing to the same integer is a numeric-label match,
which is what `NUMERIC_LABEL` means.

### `INTERNAL_DESTINATION`

A `/Link` annotation whose `/GoTo` destination resolves to a declared entry.
Both ends are identities, and neither is resolved by proximity:

* **Source.** The annotation names its owning structure element through
  `/StructParent` and the parent tree (ISO 32000-2 14.7.4.4), and that element
  must contain exactly one declared `/Reference`. Zero means it belongs to no
  declared citation; more than one would mean PalCert picking. An annotation
  with no `/StructParent` is not consumed at all — see the limitation below.
* **Destination.** A structure destination (`/SD`) names an element outright.
  Otherwise an explicit destination array, resolved through the name tree when
  it is named, gives a page and a point, and the target is the declared entry
  whose extent strictly contains it. No tolerance, because a tolerance is a
  tuned distance and a tuned distance is a guess about which entry was meant.

One entry → `LINKED`; two or more → `AMBIGUOUS` naming all of them; none →
`UNRESOLVED`, with the method still named because the attempt was real.

### When both methods have something to say

Each proposal becomes its own link row, so the evidence survives rather than
being collapsed. One case gets a rule of its own: when two methods resolve to
*different* entries, both rows would be `LINKED` and the contract's precedence
— all LINKED means LINKED — would report a confidently resolved citation while
the document offers two answers. So that case, and only that case, makes both
rows `AMBIGUOUS` over the union of what they found. Disagreement becomes
ambiguity rather than a silent choice, and no precedence order declares one
exact method more believable than another.

A citation with nothing to link by is `NOT_ATTEMPTED` rather than unresolved.

### Implementation limitation

An annotation without `/StructParent` is not read. There is no second exact way
to discover whose citation it is; the alternative is deciding from where its
rectangle sits on the page, which is the guessing this refuses. Such a document
reports its citations as `NOT_ATTEMPTED`, which is true.

### What PDF coverage says

Six domains that fail independently, because they do.

| Domain | PDF |
| --- | --- |
| `NATIVE_CITATIONS`, `NATIVE_BIBLIOGRAPHY_SOURCES`, `NATIVE_SOURCE_RESOLUTION` | `UNAVAILABLE` / `FORMAT_HAS_NO_NATIVE_CITATIONS` — the format has no Word source store, which is not the same as not having looked |
| `SEMANTIC_CITATIONS`, `SEMANTIC_REFERENCE_ENTRIES` | `PARTIAL` when tagged and readable, `UNAVAILABLE` / `NOT_IMPLEMENTED` when untagged, `UNAVAILABLE` / `NO_TEXT_LAYER` on a scan |
| `REFERENCE_REGION` | `COMPLETE` when a `/BibEntry` proves one, `UNAVAILABLE` otherwise |

The semantic domains are never `COMPLETE`, however many declarations were
found and however well they resolve: a citation the author did not tag is
invisible here, and PalCert cannot know whether the tagging was exhaustive.
Understanding the links says nothing about that.

### What a PDF may project

Two of the five, and the reason is the same reason the other three may not.

| Property | PDF | Why |
| --- | --- | --- |
| `nativeCitationCount` | UNSUPPORTED | means every Word `CITATION` field; a PDF has none, and a confident zero would fail a compliant document |
| `nativeBibliographySourceCount` | UNSUPPORTED | means Word-managed source records; a PDF has no source store |
| `nativeSourceResolved` | UNSUPPORTED | means a Word citation's tag matching a record in a Word source set; a PDF citation resolving to a rendered entry is a different relationship |
| `referenceRegionPresent` | **EXACT** | means a region *proven by structure*, which says nothing about storage; a declared `/BibEntry` proves it |
| `citationTargetResolved` | **EXACT** | means a declared citation resolving to exactly one declared entry; a tagged PDF's links target a `/BibEntry`, which is that entry |

A tagged PDF therefore carries a full citation graph — citations, entries,
links, candidates, resolutions — and publishes exactly two kinds of fact from
it. The graph is the evidence; the facts are a projection of the parts of it
the public vocabulary can carry truthfully.

The two decide independently. A tagged PDF can declare citations and no
`/BibEntry` at all: the reference region is then unproven and stays silent,
while every declared citation resolves to no declared entry — which is exactly
what `citationTargetResolved` is `false` for. One property being unprovable is
not an answer about the other.

`citationTargetResolved` is emitted once per citation PalCert actually
resolved: `LINKED` becomes `true`, `UNRESOLVED` becomes `false`, and
`AMBIGUOUS` and `NOT_ATTEMPTED` emit nothing at all. The projector reads the
citation's own `resolutionStatus` and nothing else — the producer and the
integrity pass already settled every resolution, including the case where two
exact methods disagreed, so reading the link rows here would be a second
resolution algorithm able to disagree with the first.

Its coverage depends on both `SEMANTIC_CITATIONS` and
`SEMANTIC_REFERENCE_ENTRIES`, weakest wins: an entry PalCert never identified
cannot be the target of a citation it did. Because a PDF's semantic domains
are never `COMPLETE`, this property's coverage is `PARTIAL` at best on that
format even when every identified citation resolved — which is honest, and
which is what keeps "every citation resolves" INDETERMINATE rather than
passing on the tagged citations alone.

Coverage for the projected properties is written out rather than left to the
PDF's document-level default, which is `COMPLETE`. Without an entry of its own,
a missing `referenceRegionPresent` would be read under complete coverage and
`NOT_EXISTS` would *pass* — asserting the document has no reference region,
which PalCert cannot know. The DOCX side carries the mirror of this: an
explicit `ELEMENT/CITATION/citationTargetResolved: UNAVAILABLE` entry, because
that format's citation scope *can* reach `COMPLETE`, and a rule about a
question DOCX never answers must not be read under it.

The projector reads the citation's resolution and the coverage domains, never
a link row's method. It cannot prefer `NUMERIC_LABEL` over
`INTERNAL_DESTINATION` or invent a second resolution algorithm, because it
never sees which method produced what.

## Heuristic discovery (PDF, Checkpoint 10)

Checkpoints 6 to 9 read only what a PDF's author *declared*. Most real PDFs
declare nothing — a thesis exported from a word processor has a perfect
reference list and no structure tree — so PalCert reported an empty citation
graph for them. Checkpoint 10 recovers part of that, in one narrow family and
under provenance that never pretends to be more than it is.

### What it recognizes

Two citation families. **Numeric** (Checkpoint 10): a bracketed numeric marker. `[12]`, `[3, 7, 11]`,
`[4-6]` and their en/em-dash and semicolon variants, plus the Unicode-mirrored
forms `]12[` a right-to-left run produces. A group naming several works
becomes several citations, because `[3, 7, 11]` cites three things and one
occurrence resolving to three targets could only be recorded as AMBIGUOUS —
which would say PalCert could not choose when the document named all three.

**Author-year** (Checkpoint 11): `(Smith, 2020)`, `Smith (2020)`,
`(Smith & Jones, 2021)`, `(Smith et al., 2022)` and grouped forms such as
`(Smith, 2020; Jones, 2021)`, alongside author-year reference lists whose
entries open `Smith, J. (2020).` — a shape the numeric detector could not see
at all, because an author-year bibliography is ordered alphabetically and has
no labels.

Everything either family produces carries `sourceKind: HEURISTIC` and a
`confidence`, and **none of it is projected into a fact**.

#### Author-year is the dangerous one

`[12]` is punctuation nobody writes by accident. A capitalized word beside a
four-digit number inside parentheses is ordinary English, so the grammar is
**anchored end to end rather than searching**: a parenthesised group must parse
completely, from its first character to its last, or it is not a citation.
There is no "find an author somewhere in here", and a group with one segment
PalCert cannot read is rejected whole rather than harvested for the part that
looked familiar — `(see Smith, 2020)` and `(Smith, 2020; personal
communication)` yield nothing.

On top of the anchor sits a closed list of words that are never authors
(months, weekdays, seasons, `Copyright`, `Version`, `Figure`, `Table`, …) and a
rejection of lawsuit syntax (`Smith v. Jones`).

#### Reference fields parsed

| Field | Grammar |
| --- | --- |
| surnames, in order | each `Surname, I.` unit the entry opens with |
| `normalizedFamily` | that surname, case-folded |
| publication year | the entry's parenthesised `(2020)`, including a `2020a` suffix |
| author shape | derivable from the number of surnames |
| title *(Checkpoint 12)* | the sentence after the year, refused if it contains a period |
| container title *(Checkpoint 12)* | the next segment, **only** when `, 12(3), 45-67` confirms it is a journal |
| DOI, URL *(Checkpoint 12)* | see **Identifiers** below |

Volume, issue, pages, publisher and article number have no grammar of their
own and stay **absent, not guessed** — claiming a field PalCert did not
defensibly read would put invented bibliographic data into an artifact an
evidence panel renders as fact.

No new parse method was needed and none was invented. `parseMethod` names how
an object was *identified* — `REGION_MEMBERSHIP` for an entry, and
`AUTHOR_DATE_PATTERN`, already in the citation vocabulary, for a marker — and
`parseStatus` is the separate statement of how much of its content was read.
An entry PalCert read nothing out of is `UNPARSED`; one it read anything out
of is `PARTIAL`, and **never** `PARSED`: the contract does not define which
fields a fully parsed entry must carry, so claiming it would invent a
guarantee.

### Structured parsing (Checkpoint 12)

Checkpoints 10 and 11 found reference entries. Checkpoint 12 reads what is
inside one. It discovers no citation and changes no link.

One rule decides every case: **the raw text is the source of truth, and a
field is emitted only when it is an exact substring of it.** A parsed field is
rendered by an evidence panel as though PalCert read it, so a title assembled
from fragments, a DOI with its punctuation tidied, or a journal inferred from
position would all be PalCert's prose presented as the document's. A test
sweeps every entry and finds every emitted value with `in`. Entry text is
bounded *before* parsing, so a long entry loses the fields past the bound
rather than carrying ones no reader can check.

#### Identifiers recognized

| Form | `intentEvidence` |
| --- | --- |
| `https://doi.org/10.1234/abc`, `http://dx.doi.org/...` | `RESOLVER_HOST` |
| `doi:10.1234/abc`, `DOI: 10.1234/abc` | `LABEL_PREFIX` |
| bare `10.1234/abc` | `NONE` — distinctive enough to be evidence, not to be a declaration |
| `https://example.org/page` | `URL_SCHEME` |

**Normalization is offline and identity-preserving.** A DOI folds to lower
case, because DOIs are case-insensitive for comparison; a resolver prefix is
stripped so `normalized` is the bare core, with `raw` keeping what the
document wrote so the decision stays auditable. Percent-encoding is left alone
— `%2F` and `/` are different characters in a suffix. A URL folds its scheme
and host (case-insensitive by RFC 3986) and leaves path, query and fragment
exactly as written; nothing is resolved, expanded, followed or stripped.

**An identifier whose end PalCert cannot determine carries no identity.** A
DOI suffix may legitimately end in `.`, `,`, `;`, `)` or `]`, so a candidate
ending in one of those is recorded with `boundaryStatus: AMBIGUOUS` and **no**
`normalized` value. The evidence stands; the identity is not claimed, and
nothing can match on it.

**A `doi:` label followed by something that is not a DOI** is recorded with
`syntaxStatus: INVALID` and no identity — the document said "DOI" and wrote
something else, which is a real observation about the document.

**Nothing is verified.** `syntaxStatus` is an offline shape check. No
resolver, no Crossref, no Scholar, no network of any kind — a test fails the
analysis if a socket is opened.

A URL owns its whole extent, so a path segment that looks like a DOI
(`https://example.org/papers/10.1234/abc.pdf`) stays part of the address
rather than becoming an identifier the document never stated.

#### DOI_IDENTITY (Checkpoint 13)

`DOI_IDENTITY` was in the frozen link vocabulary from Checkpoint 2 and never
fired once: a reference entry could carry a DOI and a `CitationOccurrence`
could carry nothing, so the method's own condition — the same identity on both
sides — was unsatisfiable. Checkpoint 13 closes that gap.

A citation now carries the **same** `CitationIdentifier` a reference entry
does. Not a second DOI representation: the same object, read by the same
extractor, normalized by the same function, so the comparison is of like with
like rather than of two parsers that happen to agree today.

**Read from the citation's own text and nowhere else.** A DOI in the
surrounding paragraph belongs to the paragraph. Assigning it to the nearest
citation would be proximity standing in for evidence, and the citation would
then resolve — confidently, through an *exact* method — to the wrong work.
There is no paragraph scan, no nearest-marker rule and no geometry.

| Condition | Outcome |
| --- | --- |
| the identity names exactly one entry | `LINKED` |
| it names several | `AMBIGUOUS`, every candidate listed, none chosen |
| it names none | `UNRESOLVED` |
| the citation states no usable identity | no DOI row at all |

"Usable" means `normalized` is present, which the Checkpoint-12 extractor
withholds whenever a value's end could not be determined or its shape was
malformed. Linking reads that one field, so a boundary-ambiguous or invalid
DOI is unmatchable *by construction* rather than by a second rule that could
drift from the first.

Two entries stating the same DOI are two entries. They are never deduplicated
inside the linker — collapsing them would turn a real ambiguity into a
confident link to whichever came first.

**It is one method among several, with no privileges.** A DOI proposal joins
the numeric label, the internal destination and the author-year identity, and
the frozen aggregation decides the citation's resolution. Where two methods
agree, both evidence rows survive — that repetition is the corroboration an
evidence panel should show. Where they disagree, the frozen rule makes every
row `AMBIGUOUS` over the union of what they found; DOI is not promoted above
a label and a label is not promoted above a DOI.

An exact citation is still linked only against **declared** entries, so a
heuristic entry stating the same DOI can never become the target that decides
a declared citation's resolution.

**The one method whose rows can be checked.** Every other method rests on
something the artifact does not record — a tag comparison, a label match, a
destination lookup. `DOI_IDENTITY` names an identity that is *in* the artifact
on both sides, so the integrity pass verifies it in both runtimes: a resolved
DOI link whose citation states no usable identity, or whose target does not
share it, is rejected as `DOI_LINK_WITHOUT_SHARED_IDENTITY`. Candidates are
deliberately not checked — under the disagreement rule a candidate may be
there on another method's evidence, and narrowing that union would silently
prioritize one method.

**Nothing is verified.** Matching means *this document states the same
identifier in two places*. It does not mean the work exists, that the DOI
resolves, or that anyone registered it. No resolver, no Crossref, no Scholar.

A numbered reference entry with a clear author-year structure **is** parsed
into bibliographic fields, but that does not make it a candidate for an
author-year citation. Checkpoint 11 reports `NOT_ATTEMPTED` for an
author-year marker in a numbered thesis, because there is no author-year
population to look in; letting enrichment change that would turn it into
`UNRESOLVED` — an attempt PalCert never made, reported as one that failed.
Enriching an entry and making it matchable are separate decisions, and only
the first was taken here.

Parsing adds no confidence of its own. An entry's confidence says how sure
PalCert is that it *is* a reference entry; reading a DOI out of it does not
change that, and no parsed field feeds resolution.

#### Matching

`AUTHOR_YEAR_UNIQUE`, used only when it is true to its name. The identity is
the case-folded first surname plus the year token, compared **exactly** — no
stemming, no transliteration, no diacritic stripping, no initial-only
fallback, no edit distance. Each of those turns a comparison into a judgement,
and a wrong judgement points a citation at the wrong work.

| Outcome | Meaning |
| --- | --- |
| `LINKED` | the identity names exactly one parsed entry |
| `AMBIGUOUS` | it names several; every one is listed and none is chosen |
| `UNRESOLVED` | it names none, and there were identities to search |
| `NOT_ATTEMPTED` | there was no author-year identity in the document to search at all |

That last row is the case a numbered bibliography produces: a `(Smith, 2020)`
in the prose of a thesis whose reference list is `[1] Smith…` has no
author-year population to be looked up in, so no attempt is defensible and no
link row is written.

**Author shape breaks a tie and never creates one.** When an identity already
names more than one entry — `Smith, J. (2020)` and `Smith, J., & Jones, B.
(2020)` — the shape of the citation (`Smith` vs `Smith & Jones`) can narrow it
to one. It can only ever *remove* candidates, so two solo Smith 2020 entries
stay two candidates and the citation stays AMBIGUOUS. Confidence is never
consulted: a graded belief about whether a marker was recognized says nothing
about which of two works was meant.

### Several reference regions (Checkpoint 14)

Checkpoints 10 to 13 read a document as having exactly one bibliography: the
last heading whose following lines looked like entries. That is right for a
thesis and wrong for a book of chapters, a collection of articles, or a report
whose appendix carries its own sources — and being wrong there does not produce
a *missing* region but a silently mis-scoped one, in which `[1]` in chapter two
resolves confidently to chapter one's first entry.

PalCert now finds as many regions as a document defensibly has, and **never
merges them**. Each keeps its ordinal, family, heading evidence, page range,
entry population, signal set and confidence, and all of them are published in
`citationAnalysis.referenceRegions`; each discovered entry names its region in
`regionOrdinal`. Publishing them is what makes a numeric link checkable at all:
`[1]` resolving to `r4` is right when `r4` belongs to the region serving that
chapter and wrong when it does not, and until now a reader had no way to tell.

**The region serving a citation is the first region that begins after it.** A
reference list serves the text it follows — that is what a per-chapter
bibliography is — so ordinal containment decides. There is no nearest-region
rule, no page-distance ranking and no threshold. Where no region follows a
citation, PalCert widens to the document-wide population and reports
`AMBIGUOUS` over every candidate rather than falling back to the nearest list,
the last list, or the list whose confidence is highest.

Region context restricts *which entries a method may choose from* and does
nothing else. It never gives one link method priority over another, and the
frozen multi-method disagreement rule is unchanged. See ADR-0137.

### Three region families

| Family | Entry shape | How it is told apart |
| --- | --- | --- |
| `NUMBERED` | `[1] Smith, J. Water rights.` | a bracketed label opens the line |
| `VANCOUVER` | `1. Smith J, Jones A. Water rights.` | a bare number **and** `Surname AB` after it |
| `AUTHOR_YEAR` | `Smith, J. (2020). Water rights.` | surname and initials open the line |

The bracketed family is tried first, so a document earlier checkpoints already
read is read identically.

`VANCOUVER` is the one Checkpoint 10 declined. An unbracketed numbered list
collides exactly with an ordinary numbered list, and the number is what both
have. The grammar earns the family back rather than relaxing into it: the
`Surname AB` following the number is doing all the work, so `1. Collect the
samples` and `2. Weigh them carefully` match nothing. The number says "list";
only the author shape says "reference".

### Two more numeric citation forms (Checkpoint 14)

**Raised numerals** — `…contested³`, `…both³,⁵,⁷`, `…a range⁴⁻⁶`. Invisible to
every text-level detector, because as characters a superscript is plain digits.
Three geometric conditions gate a marker, all of them strict inequalities or
interval overlap and none of them tuned: the span's text is a numeric group and
nothing else, some span on its visual line is set **larger**, and its bottom
sits strictly **above** that span's.

Geometry is never enough on its own, and that is the whole point. `x²` has the
identical shape. So a raised numeral becomes a citation only when it **also
names a reference entry that exists** in the region serving that part of the
document, and only when the text it is attached to does not end in a lone
letter — which is what a variable looks like. A raised numeral matching nothing
is reported as nothing. See ADR-0138.

**Parenthesised Vancouver groups** — `(3)`, `(3,5,7)`, `(3-5)`. Round brackets
are the hardest numeric form to read, because the shape is shared with equation
numbers, list markers and function subscripts. What makes the form supportable
is not a better pattern but a document-derived precondition: PalCert reads it
only in a document that numbers its own reference list **without** brackets. A
document whose bibliography reads `[7] Smith, J.` writes its markers `[7]`, so
`(7)` there is something else, and reading it would be reading against the
author's own established style.

Four further conditions each remove one look-alike: every number must name an
entry in the serving region; the group must not be glued to an identifier
(`f(3)`, `arr(12)`); it must not follow an arithmetic operator (`x = (3)`,
`n + (4)`) nor sit on a line carrying one earlier (`E = mc² (2)`, which is a
display equation's number rather than a citation); and some letter must precede
it on the line, so a line *opening* `(3)` is a list marker and an isolated `(3)`
at the right margin is an equation number.

The bracketed forms are unchanged.

### The confidence model

One table of named signals with fixed weights, in `app/pdf/heuristics.py`.
Within each group the weights sum to 1, so a confidence is the fraction of the
evidence that *could* have been present, scaled by a ceiling of `0.95`.

| Group | Signals |
| --- | --- |
| Region | heading vocabulary `0.30`; entry structure `0.30`; latter-document position `0.15`; label-sequence coherence `0.15`; typography continuity `0.10` |
| Numeric entry | region accepted `0.40`; bracketed label at line start `0.30`; label in sequence `0.20`; typography matches region `0.10` |
| Numeric citation | region accepted `0.40`; bracketed numeric syntax `0.30`; label within the reference range `0.20`; corroborated by another marker on the page `0.10` |
| Author-year entry | region accepted `0.40`; surname and initials at start `0.30`; plausible year `0.20`; typography matches region `0.10` |
| Author-year citation | region accepted `0.30`; author-year syntax `0.25`; plausible year `0.15`; identity matches a parsed entry `0.20`; identity unique `0.10` |

The groups are declared rather than derived from a name prefix, so a signal
can never be counted against the wrong scale. Which entry *family* a region
uses is recorded on the region itself rather than as a signal: a confidence
says how much evidence there was, not what kind.

Two properties follow from the table alone and are tested over every subset.
**Monotonicity**: every weight is non-negative, so a candidate satisfying a
superset of another's signals can never score lower. **No certainty**: the
ceiling is below 1, because the signals are the evidence this detector knows
how to look for and not the evidence that exists.

Confidence never decides anything. It does not promote an AMBIGUOUS link to
LINKED, it does not override an exact object, and the semantic integrity pass
never reads it.

### A heading is never proof

A region is accepted only when heading vocabulary **and** numbered-entry
structure both hold — a paper discussing bibliographies in its prose has the
word and not the list. Headings are matched from a closed vocabulary
(`References`, `Bibliography`, `Works Cited`, `المراجع`, `قائمة المراجع`,
`المصادر`, …), normalized for case, spacing, ordinal numbering and bidi marks,
and compared in both reading directions.

That last point is not a loosening. PalCert never reorders extracted text — a
Phase 13 rule — and a PDF's text layer may present a right-to-left run in
visual order, so which direction reaches a detector depends on the producer. A
reversal is an exact, information-preserving transformation of the same
characters, and a Latin heading read backwards matches nothing either way.

### False-positive protections

| Class | Why it is rejected |
| --- | --- |
| Years (`[2020]`) | above the plausible label range, which removes every four-digit year without a rule that mentions years |
| Page and section numbers, table and figure labels | not bracketed at all |
| Ordinary numbered lists (`1. First step`) | not bracketed; only `[n]` opens an entry |
| Equation references (`(3)`, `[3.4]`) | parentheses are not matched; `3.4` is not a number |
| Non-citation ranges (`[12-4]`, `[1-400]`) | descending, or implausibly wide for a citation |
| The reference list's own labels | the region is excluded from in-text discovery outright |
| A mathematical exponent (`x²`) | the text it is attached to ends in a lone letter, and 2 would have had to name an entry |
| Chemical notation (`H₂O`) | a subscript is not strictly *above* the running text, so it never becomes a marker |
| A footnote marker or ordinal set raised | it names no entry in the serving region, and the entry was the only reason to read it as a citation |
| A raised numeral in a document with no recognized list | there is no population to check the number against |
| `(3)` in a bracket-numbering document | the author's own style writes markers `[3]` |
| `f(3)`, `arr(12)` | glued to an identifier |
| `x = (3)`, `n + (4)` | follows an arithmetic operator |
| `E = mc² (2)` | a mathematical operator appears earlier on the line, so the number belongs to a display equation |
| `(3)` opening a line or alone at the right margin | no running text precedes it on the line |
| An unbracketed numbered list (`1. Collect the samples`) | no `Surname AB` follows the number |
| Dates (`(March, 2020)`) | a closed list of words that are never an author |
| Copyright notices (`(Copyright, 2019)`) | the same list |
| Legal citations (`(Smith v. Jones, 2020)`) | lawsuit syntax is rejected outright |
| A locator after the year (`(Smith, 2020, p. 14)`) | the group must parse end to end |
| A qualifier before the author (`(see Smith, 2020)`) | likewise |
| A lowercase word (`(smith, 2020)`) | a surname must be capitalized |
| A name followed by an unrelated year | no parentheses, no citation |
| A DOI-shaped number with no label or resolver (`Volume 10.1234 of a series`) | the `10.xxxx/` shape requires the slash |
| A URL without a scheme (`www.example.org`) | supplying the scheme would invent part of the value |
| A title spanning a sentence break (`... in the U.S. basin.`) | any candidate containing a period is refused |

Discovery is attempted only in a document whose region was accepted: a
bracketed number in a file with no bibliography is more likely a footnote
marker or a measurement, and there would be nothing to link it to.

### Exact and heuristic together

A PDF may declare part of its citation structure and merely typeset the rest.
The merge is deterministic and exact evidence always wins:

* exact objects keep their ids, ordinals, provenance, links and resolution,
  and heuristic objects are **appended** after them — adding this layer cannot
  renumber an artifact somebody already stored;
* a heuristic candidate whose spans are already claimed by a declared element
  is **dropped, not merged**. The overlap test is span node identity, never
  textual similarity: a span is the one the author stamped or it is not, so
  there is no threshold and nothing to tune;
* an **exact** citation is linked only against **declared** entries. A
  heuristic entry can never become the target that decides a declared
  citation's `resolutionStatus`;
* the two heuristic families claim character ranges within a line, numeric
  first, so one marker can never become two citations and an existing
  `NUMERIC_LABEL` citation is never reinterpreted as author-year.

### Advisory projection (Checkpoint 15)

Checkpoints 10 to 14 projected none of the heuristic layer. Checkpoint 15 does,
and the thing that makes it safe is a change to the **evaluator**, not a
judgement about the numbers.

The audit that opened the checkpoint found three facts about the engine:

* it checks `failed > 0` **before** it looks at coverage, so `PARTIAL` demotes
  a PASS and does nothing whatever to a FAIL;
* it never read `provenance` at all, so a `HEURISTIC` fact decided a rule
  exactly as an `OOXML` one did;
* it stamped every PASS and FAIL `DETERMINISTIC`, whatever produced it.

So projecting a heuristic count as an ordinary fact could have failed a
compliant document, and the label a report reads would not have shown it. All
three are pinned as characterization tests.

**The rule now is: a fact PalCert did not read cannot decide.** A rule matching
any fact whose `provenance.sourceKind` is `HEURISTIC` returns `INDETERMINATE`
with reason `ADVISORY_EVIDENCE_ONLY` and evidence level `ADVISORY`. It keys on
provenance rather than on a property name — so an analyzer bug that emitted a
heuristic value for an exact property is harmless — and one heuristic fact
makes the whole rule advisory, because a verdict resting partly on a
recognition is not partly authoritative.

### What advisory evidence may say

| Property | Kind | Means |
| --- | --- | --- |
| `observedCitationCount` | `ADVISORY_COUNT` | how many in-text citations the current detector recognized |
| `observedReferenceCount` | `ADVISORY_COUNT` | how many entries it segmented out of the regions it accepted |
| `observedReferenceRegionPresent` | `ADVISORY_POSITIVE_MARKER` | it recognized a reference list nobody declared |

Three document-level rows and deliberately no more. No candidate ids, no link
methods, no parsed titles, no DOIs, no per-citation assertions: those stay in
the artifact, labelled as evidence, and none of them has a public property
contract.

Four disciplines apply to all three:

* **Heuristic objects only.** The declared ones are already answered exactly,
  and a number mixing both could carry neither provenance honestly. The two
  populations are disjoint by construction, because the analyzer suppresses any
  heuristic object overlapping a declared span.
* **Affirmative or absent.** A count of zero restates the fact's own absence,
  so an exact-only document's fact set is unchanged.
* **`PARTIAL`, never `COMPLETE`.** "We read the whole file" is not "we
  recognized everything in it".
* **Confidence only where an honest one exists.** The region marker carries the
  strongest contributing region's own number — a selection, not a computation,
  because the claim is existential. The counts carry none: a single figure
  beside "6" would have to mean confidence that there are six, which is not
  what any per-object number measured.

### Why advisory evidence cannot certify a document

A chain, each link tested rather than asserted:

1. an advisory rule is always `INDETERMINATE`;
2. **the determination ignores advisory results entirely** (Checkpoint 16):
   removing every advisory result from a check changes the determination, the
   score and every count by nothing;
3. only `COMPLIANT` plus `APPROVED` issues a certificate.

So an advisory rule cannot move a determination in *either* direction.
**Heuristic evidence can neither grant a certificate nor withhold one.**

Checkpoint 15 stopped at the first half of that. Its aggregation let a blocking
advisory rule move a `COMPLIANT` document to `INDETERMINATE`, which looks
conservative and is not: a detector failing to recognize a citation style would
have cost a student a certificate their thesis had earned. ADR-0140 removes it,
and refuses a blocking rule about an advisory-only property at authoring time
rather than ignoring it silently.

The one case advisory evidence decides is by its absence: a standard with
results but no authoritative ones is `INDETERMINATE`, never `COMPLIANT`. The five exact properties are untouched, and `referenceRegionPresent`
keeps meaning "proven by structure" — the recognition is a differently named
row beside it, never a heuristic value of it.

### Compatibility preview

`ADVISORY` is a fourth support level beside `EXACT`, `DERIVED` and
`UNSUPPORTED`. It is not a weaker `EXACT` and not a variant of `DERIVED`: those
two are computations over what the format stores, exhaustive and repeatable,
while this is a belief about what the document contains.

The preview counts advisory rules in a bucket of their own — `advisoryRules`
and `advisoryProperties`, disjoint from supported and unsupported and summing
with them to the total — and never reports `FULL` when one is present. A
standard made entirely of advisory rules reports `NONE`, because nothing in it
can be *answered* from this format. That number is what somebody reads before
deciding to pay.

See ADR-0139.

### Projection safety

`citationTargetResolved` is an `EXACT_ELEMENT_VALUE` and `referenceRegionPresent`
an `EXACT_POSITIVE_MARKER`. Neither may be published from a guess, however
cleanly the guess resolved, so each is gated independently:

| Property | Gates |
| --- | --- |
| `citationTargetResolved` | the linker gives exact citations a declared-entries-only index; the projector filters the citation list to `sourceKind: PDF_TEXT`; the coverage population is the declared citations |
| `referenceRegionPresent` | the `REFERENCE_REGION` coverage domain stays declared-only; `summary.referenceRegionObserved` counts declared entries only; the projector checks the entries' own provenance |

No public heuristic property exists, and `document-property-support.json` is
unchanged. Projecting heuristic evidence is a later checkpoint's decision.

### Coverage

`SEMANTIC_CITATIONS` and `SEMANTIC_REFERENCE_ENTRIES` move off
`UNAVAILABLE / NOT_IMPLEMENTED` for an untagged document only when a detector
actually produced objects — and then only to `PARTIAL`. Two families is not
every family: note markers, superscript numerals, Vancouver variants and every
Arabic-script author-year form are invisible here, and `COMPLETE` would deny
that any of them could exist. Image-only PDFs stay `UNAVAILABLE / NO_TEXT_LAYER`, and the three
native domains are untouched.

## Not implemented

Fuzzy or semantic matching of any kind; external verification of any
identifier;
volume, issue, pages, publisher and article number, which have no grammar of
their own; reference entries written without initials; heuristic discovery for
DOCX;
**Arabic-script author-year recognition** (see below);
**raised Arabic-Indic citation markers**, whose geometry the corpus's synthetic
composite font cannot express (see below); reference entries written without
initials (`Smith 2020. Title.`);
author-year matching against a *numbered* reference list, whose entries are
identified but not parsed; parsing of titles, journals, volumes, pages or
identifiers out of a recognized entry; projection of heuristic evidence into
any public property; orphan and uncited analysis; duplicate confirmation;
`CheckReport` integration; any user interface.

### Arabic

Numeric discovery works in Arabic and has since Checkpoint 10: the `المراجع`
heading vocabulary, Arabic-Indic digit folding and both Unicode-mirrored
bracket orders. The author-year grammar accepts Arabic punctuation too — the
Arabic comma `،`, the Arabic semicolon `؛`, `و` as a conjunction and ornate
parentheses — so a bilingual document writing `(Smith، ٢٠٢٠)` is recognized.

**Arabic-script author names are not recognized, deliberately.** The Latin
grammar's safety rests almost entirely on the leading capital: it is the only
deterministic signal a text layer offers that separates a name from an
ordinary word. Arabic script has no case, so recognizing "any Arabic word
followed by a year in parentheses" would manufacture citations out of
ordinary prose — and a name that *was* recognized could not be matched
reliably either, because Arabic surname normalization (the definite article
`ال`, `ابن`/`بن`, tāʾ marbūṭa, hamza variants) is a transliteration problem
rather than a case-folding one. Detection without matching would still put
false citations in the artifact, so this checkpoint recognizes none and says
so here rather than guessing. SmartFix remains unable to edit a `CITATION`
or `REFERENCE_ENTRY` element at all — that guard landed in Checkpoint 1 and is
unchanged.

**Raised Arabic-Indic markers are not tested, and the reason is the corpus
rather than Arabic.** The golden corpus writes Arabic through a synthetic
composite font whose glyph program is empty, so PDFium reports Arabic glyphs
with essentially no vertical extent. A raised marker is recognized by its box
sitting strictly above a body span's, and boxes of near-zero height cannot
express that relation. A real Arabic PDF embeds a real typeface with real
metrics and would not have the problem — but PalCert declines to claim support
it cannot demonstrate, and the checkpoint is explicit that a superscript must
not be synthesized to make a test pass. The limitation is pinned by a test, so
a corpus that ever gains a font with real metrics will fail it and force the
gap to be revisited on purpose.

---

For the closing per-format inventory of what Phase 18 supports, observes and
deliberately does not do, see [the Phase 18 capability matrix](phase-18-capability-matrix.md).
