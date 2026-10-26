# Phase 18 final capability matrix

What PalCert can and cannot do with citations and references at the close of
Phase 18, per format, with each capability marked **supported** (authoritative),
**advisory** (observed, never decides) or **unsupported** (deliberately absent).

This is the closing statement of the phase. `citations.md` explains *how* each
piece works and why; this page is the inventory.

## The governing distinction

Phase 18 has two evidence classes and they never merge:

| | Reads | Produces | Can decide compliance? |
| --- | --- | --- | --- |
| **EXACT** | what the author declared — OOXML markup, a PDF structure tree | authoritative facts | yes |
| **HEURISTIC** | what PalCert recognized — patterns, geometry, region structure | advisory facts | **no** |

The reason is not caution for its own sake. The deterministic engine checks
`failed > 0` before it looks at coverage, so `PARTIAL` prevents a false pass and
does nothing whatever about a false failure. A heuristic count projected as an
ordinary fact could therefore fail a compliant document, and no coverage status
would intervene. So the evaluator refuses to decide on a fact whose provenance
is `HEURISTIC` (ADR-0139), and the determination ignores advisory results
entirely (ADR-0140).

## Discovery

| Capability | DOCX | PDF |
| --- | --- | --- |
| Exact citation extraction | **supported** — `CITATION` fields | **supported** — tagged `/Reference` |
| Exact reference-entry extraction | **supported** — `BIBLIOGRAPHY` field | **supported** — tagged `/BibEntry` |
| Word bibliography source records | **supported** | unsupported — a PDF has no source store |
| Heuristic reference-region discovery | **unsupported** | **advisory** |
| Heuristic reference-entry segmentation | **unsupported** | **advisory** |
| Heuristic in-text citation discovery | **unsupported** | **advisory** |
| Multiple reference regions | unsupported | **advisory** — per chapter, appendix, collection |
| OCR of a scanned page | unsupported | unsupported — coverage is `UNAVAILABLE` |

DOCX heuristic discovery was never attempted: a DOCX that declares its citations
is read exactly, and one that does not is a deferred roadmap item rather than a
gap this phase left open by accident.

## Citation styles recognized (PDF heuristics)

| Form | Example | Status |
| --- | --- | --- |
| Bracketed numeric | `[12]`, `[3, 7, 11]`, `[4-6]` | **advisory** |
| Bidi-mirrored brackets | `]12[` | **advisory** |
| Arabic-Indic numerals | `[١٢]` | **advisory** |
| Raised numeric | `…contested³`, `…both³,⁵,⁷`, `…a range⁴⁻⁶` | **advisory** |
| Parenthesised Vancouver | `(3)`, `(3,5,7)` | **advisory** — only where the document numbers its own list without brackets |
| Author-year parenthetical | `(Smith, 2020)`, `(Smith & Jones, 2021)`, `(Smith et al., 2022)` | **advisory** |
| Author-year narrative | `Smith (2020)` | **advisory** |
| Grouped author-year | `(Smith, 2020; Jones, 2021)` | **advisory** |
| Arabic-script author names | `(الخطيب، ٢٠٢٠)` | **unsupported** — see limitations |
| Raised Arabic-Indic markers | — | **unsupported** — see limitations |

## Reference list families (PDF heuristics)

| Family | Entry shape | Status |
| --- | --- | --- |
| `NUMBERED` | `[1] Smith, J. Water rights.` | **advisory** |
| `VANCOUVER` | `1. Smith J, Jones A. Water rights.` | **advisory** |
| `AUTHOR_YEAR` | `Smith, J. (2020). Water rights.` | **advisory** |

## Link methods

| Method | DOCX | PDF | Notes |
| --- | --- | --- | --- |
| `NATIVE_TAG` | **supported** | unsupported | a Word citation's tag against a source record |
| `INTERNAL_DESTINATION` | unsupported | **supported** | a link annotation resolving to a declared entry |
| `NUMERIC_LABEL` | **supported** | **supported** | exact between declared objects; advisory between recognized ones |
| `DOI_IDENTITY` | **supported** | **supported** | both sides must state the same normalized DOI |
| `AUTHOR_YEAR_UNIQUE` | unsupported | **advisory** | Latin script only |
| `STRUCTURED_TUPLE` | unsupported | unsupported | deferred |

Resolution outcomes are `LINKED`, `AMBIGUOUS`, `UNRESOLVED` and
`NOT_ATTEMPTED`. When two methods resolve to *different* entries, every row
becomes `AMBIGUOUS` over the union — disagreement becomes ambiguity rather than
a silent choice between methods.

## Structured bibliographic fields (PDF heuristics)

Every parsed field is an exact substring of the entry's own `rawText`
(ADR-0135).

| Field | Status |
| --- | --- |
| Authors (surname + initials) | **advisory** |
| Year | **advisory** |
| Title | **advisory** — never manufactured merely because text follows the year |
| Container title | **advisory** |
| DOI | **advisory** — parsing, never verification |
| URL | **advisory** |
| Volume, issue, pages, article number, publisher | **unsupported** — no defensible grammar |
| ISBN, ISSN | **unsupported** |

No identifier is ever resolved over the network. `parseStatus` is never
`PARSED`, only `PARTIAL` or `UNPARSED`, because the contract does not define
what "fully parsed" would require.

## Public properties

### Exact — may decide compliance

| Property | Scope | DOCX | PDF |
| --- | --- | --- | --- |
| `nativeCitationCount` | DOCUMENT | **EXACT** | UNSUPPORTED |
| `nativeBibliographySourceCount` | DOCUMENT | **EXACT** | UNSUPPORTED |
| `nativeSourceResolved` | ELEMENT/CITATION | **EXACT** | UNSUPPORTED |
| `referenceRegionPresent` | DOCUMENT | **EXACT** | **EXACT** |
| `citationTargetResolved` | ELEMENT/CITATION | UNSUPPORTED | **EXACT** |

Frozen since Checkpoint 9 and unchanged by everything after it.

### Advisory — reported, never decides

| Property | Scope | DOCX | PDF |
| --- | --- | --- | --- |
| `observedCitationCount` | DOCUMENT | UNSUPPORTED | **ADVISORY** |
| `observedReferenceCount` | DOCUMENT | UNSUPPORTED | **ADVISORY** |
| `observedReferenceRegionPresent` | DOCUMENT | UNSUPPORTED | **ADVISORY** |

Counted over heuristic objects only, emitted affirmatively or not at all, and
never carrying `COMPLETE` coverage. A rule about one is always `INDETERMINATE`
with evidence level `ADVISORY`, and a *blocking* rule about one is refused at
authoring time.

Everything else Phase 18 observes — candidate ids, link methods, parsed titles,
DOIs, URLs, per-object confidences, orphan and duplicate counts — stays inside
the analysis artifact as evidence and has no public property.

## Coverage semantics

| Domain | DOCX | PDF |
| --- | --- | --- |
| `NATIVE_CITATIONS` | `COMPLETE` / `PARTIAL` | `UNAVAILABLE` |
| `NATIVE_BIBLIOGRAPHY_SOURCES` | `COMPLETE` / `PARTIAL` | `UNAVAILABLE` |
| `NATIVE_SOURCE_RESOLUTION` | `COMPLETE` / `PARTIAL` | `UNAVAILABLE` |
| `SEMANTIC_CITATIONS` | `PARTIAL` / `UNAVAILABLE` | `PARTIAL` / `UNAVAILABLE` |
| `SEMANTIC_REFERENCE_ENTRIES` | `PARTIAL` / `UNAVAILABLE` | `PARTIAL` / `UNAVAILABLE` |
| `REFERENCE_REGION` | `COMPLETE` / `UNAVAILABLE` | `COMPLETE` / `UNAVAILABLE` |

The semantic domains are **never** `COMPLETE` in this phase, in either format.
Recognizing more styles says PalCert knows more of what a document may contain;
it says nothing about the styles it still cannot name.

An image-only PDF is `UNAVAILABLE` throughout. Discovery was never attempted,
which is a different statement from finding nothing.

## Compatibility preview

Four support levels, reported distinctly: `EXACT`, `DERIVED`, `ADVISORY`,
`UNSUPPORTED`. Advisory rules are counted in their own bucket, disjoint from
supported and unsupported and summing with them to the total. A standard with
any advisory rule is never `FULL`; a standard of nothing but advisory rules is
`NONE`, because nothing in it can be *answered* from that format.

## Known limitations

Each is a deliberate refusal with a reason, not an unfinished edge. All are
carried to the roadmap.

| Limitation | Why it was refused |
| --- | --- |
| Arabic-script author-year recognition | the Latin grammar's safety rests on the leading capital, and Arabic script has no case; recognizing "any Arabic word before a year" would manufacture citations out of ordinary prose |
| Raised Arabic-Indic citation markers | the corpus's synthetic composite font exposes no glyph height, so raised-baseline geometry cannot be demonstrated; synthesizing it to pass a test was refused |
| Fuzzy and semantic author/title matching | no deterministic definition, and a wrong match resolves confidently to the wrong work |
| ISBN / ISSN parsing and linking | no link method in the frozen vocabulary rests on them |
| URL identity linking | a URL identifies a location, not a work |
| DOCX heuristic discovery | never attempted; a DOCX that declares its citations is read exactly |
| Unbracketed lists whose openers are not author-shaped | indistinguishable from an ordinary numbered list |
| Volume, issue, pages, publisher parsing | no grammar that does not guess |
| Footnote-numbered documents whose numbers fall inside the bibliography's range | a raised marker naming a real entry is indistinguishable from a citation |
| Region scoping for a citation following every list | reported `AMBIGUOUS` rather than guessed; a document interleaving lists and text unusually could still be mis-scoped |
| Element-level advisory assertions | document-level counters first; per-citation observed resolution is deferred |
| External verification of any identifier | Phase 18 parses, and never resolves over the network |

## Analyzer versions at close of phase

| Analyzer | Version | Meaning |
| --- | --- | --- |
| `palcert-docx` | `4` | unchanged since Checkpoint 9 |
| `palcert-pdf` | `11.0.0` | advisory projection (Checkpoint 15) |

Envelope schema version 2, structural model version 1,
`citationAnalysisSchemaVersion` 1 — the last unmoved through three additive
changes, because each was optional and every stored artifact stayed valid.
