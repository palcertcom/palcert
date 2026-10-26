# DOCX document analysis

_Status: current as of Phase 6._

Phase 6 turns a READY DOCX into deterministic facts the Phase 4 rule engine can
evaluate:

```
READY DOCX version → secure OOXML parser → normalized structural model
  → effective formatting resolution → DocumentFactSet → immutable artifact
```

Nothing here decides compliance. No standard is selected, no rule is evaluated,
no score is computed, no model is called. Those are Phase 7 and later.

## 1. What a DOCX can and cannot tell us

WordprocessingML stores **content and formatting intent**: paragraphs, runs,
styles, sections, relationships. It does **not** store the result of laying that
out — page boundaries, line positions, the page a paragraph lands on, or an
authoritative page count.

So the analyzer reports page _setup_ (declared) and never page _position_
(computed). No fact carries a page number; `PAGE` coverage is `UNAVAILABLE`;
the page count Word saved in `app.xml` is recorded as an application _hint_ and
never promoted to a fact. See [ADR-0043](../adr/0043-structural-analysis-knows-no-pages.md).

The same discipline applies to application defaults. If a property is declared
nowhere — not on the run, not in the style chain, not in `docDefaults`, not
through the theme — PalCert emits no fact. Word would render Calibri 11 pt;
that is Word's choice, not something the document proves
([ADR-0039](../adr/0039-raw-ooxml-parsing.md)).

## 2. The source

Only a version with `status = READY` and `detectedFormat = DOCX` is analyzable.
The worker reads the **exact clean object version** Phase 5 recorded
(`cleanObjectKey` + `cleanObjectVersionId`) — never the quarantine object, never
the latest version of a key, never a path from a request.

Before anything is believed, the bytes are hashed and compared with the
version's authoritative `sha256`. A mismatch is
`DOCUMENT_SOURCE_INTEGRITY_FAILED`: fatal, never retried, no artifact written.
The analyzer verifies the digest again on its own side, so a swapped object
fails on both sides of the service boundary.

## 3. Parsing safely

Phase 5 proved the ZIP is not a bomb. It proved nothing about the XML inside,
which is attacker controlled.

- **Any DOCTYPE is refused outright.** Every entity attack — XXE, billion
  laughs, parameter entities — enters through one, so the whole construct is
  rejected rather than selectively defused. External entity resolution and
  parameter-entity parsing are refused as independent second layers.
- **Limits are enforced while parsing, not after**: XML depth, element count,
  part bytes, total XML bytes, plus analyzer limits on paragraphs, runs,
  tables, cells, styles, numbering definitions, relationships, sections, notes,
  drawings, facts and artifact size. Every one is a named constant in
  `app/docx/limits.py`.
- **Parts are found through OPC relationships**, not at fixed paths. A target
  that would escape the package is refused. An **external** relationship is
  recorded as data and never fetched: the analyzer makes no network call.
- **Both OOXML profiles** are supported. Transitional and ISO Strict differ
  only in namespace URIs, and parsing a Strict package with Transitional names
  finds nothing — which would report an empty document with confident
  coverage. An unrecognized profile fails explicitly.
- **Markup compatibility** is resolved to exactly one branch: `mc:Choice` when
  present, `mc:Fallback` otherwise. Taking both would double-count a shape;
  taking neither would lose it. Drawing geometry remains PARTIAL. Text-box
  formatting can be COMPLETE when every branch has identical expanded XML
  structure, attributes and text. `figurePlacement` has its own coverage: native
  inline/anchor placement must agree with a single, supported VML shape in
  each fallback. Different boxes, unknown branches, groups, malformed CSS or
  conflicting placement remain PARTIAL. Warnings are retained; no global
  warning is simply ignored to obtain a passing score.

## 4. Stories

Content lives in independent flows, and each keeps its own identity:

| Story              | Element type for its paragraphs                        |
| ------------------ | ------------------------------------------------------ |
| main document      | `PARAGRAPH`, or `HEADING` when it has an outline level |
| header / footer    | `HEADER` / `FOOTER`                                    |
| footnote / endnote | `FOOTNOTE` / `ENDNOTE`                                 |
| text box           | `TEXTBOX`                                              |
| comments           | counted only; text is never extracted                  |

Filing a header's page number under `PARAGRAPH` would make a rule about body
text fail because of a running head. `ENDNOTE` and `TEXTBOX` did not exist in
fact schema v1, which is why Phase 6 introduces v2 (§7 below).

The walker descends _through_ containers — `w:sdt`, `w:hyperlink`,
`w:customXml`, smart tags — so text is never lost because of its wrapper.

## 5. Deterministic locations

Every element has a structural node id: the story, then the ordinal path of
element kinds from that story's root.

```
main/body/p:17                     main/body/p:17/r:2
main/body/tbl:1/tr:3/tc:2/p:1      header:default:1/p:3
footnote:4/p:2                     endnote:4/p:2
```

Ordinals are 1-based per element kind within a parent, so inserting a table
before a paragraph does not renumber the paragraphs. The same bytes and the
same analyzer version always produce the same ids — nothing derives from a
UUID, a sequence, a clock or the text itself. Node ids are **locators, not
selectors**: no client-supplied string is ever evaluated against a document.

## 6. Effective formatting

The hierarchy is applied in the order ECMA-376 gives:

```
document defaults → table style → numbering style
  → paragraph style chain (root first) → character style chain → direct
```

**Toggle properties XOR** across the style hierarchy (ECMA-376 §17.7.3), with
direct formatting absolute. A style based on a bold style that declares
`<w:b/>` again is _not_ bold — the case naive last-writer-wins resolution gets
backwards. Twelve properties are in that family; everything else overrides.

**Declared-false is not absent.** `<w:b w:val="0"/>` is an instruction; silence
means "ask the next layer".

**Theme references are resolved.** `@w:asciiTheme="minorHAnsi"` selects the
theme's minor Latin region. Analyzer version 6 also reads `w:themeFontLang`
from document settings: `val`, `eastAsia` and `bidi` select supplemental
`a:font` entries for the Latin, East Asian and complex-script regions. For
example, `bidi="ar-PS"` selects `script="Arab"`. A bounded language-to-script
mapping and explicit BCP 47 script subtags are supported; unknown or ambiguous
languages remain unresolved. Run text, `w:lang` and the host locale are not
used to guess the theme language. Without a regional language setting, the
theme's regional typeface is used.

An unresolvable reference leaves that font _unresolved_, including when a
lower style layer had a literal font. A later direct font can resolve it.
Coverage is PARTIAL only for the affected element type and used font property;
an unresolved, unused complex-script font does not invalidate a fully known
Latin font or independently known font size. Warnings remain diagnostic.

**Style chains are bounded and cycle-safe.** A missing parent ends the chain
with a warning; a cycle is detected, warned and cut; an over-deep chain is cut
at the limit. All three degrade the affected domains to PARTIAL rather than
failing the document, because a user cannot fix a broken template by trying
again. See [ADR-0040](../adr/0040-effective-formatting-resolution.md).

**Provenance is recorded** for every resolved value — source layer, style id,
theme token — because Phase 12 SmartFix must know whether a font came from one
run or from a style four hundred paragraphs share.

## 7. Script-aware typography

A run holding "Hello مرحبا" has two fonts and two sizes. Run text is therefore
segmented by script channel, and each segment reads its own slot:

| Channel        | Font slot                         | Size     | Bold / italic    |
| -------------- | --------------------------------- | -------- | ---------------- |
| Latin          | `@w:ascii` (< U+0080), `@w:hAnsi` | `w:sz`   | `w:b`, `w:i`     |
| Complex script | `@w:cs`                           | `w:szCs` | `w:bCs`, `w:iCs` |
| East Asian     | `@w:eastAsia`                     | `w:sz`   | `w:b`, `w:i`     |

Classification is by Unicode block and is documented in `app/docx/script.py`;
Arabic is never identified by "not ASCII". Facts are named for their channel:
`fontFamilyComplexScript`, `fontSizeComplexScript`, `boldComplexScript`. See
[ADR-0044](../adr/0044-script-aware-typography.md).

## 8. Fact schema v2

Phase 4's element vocabulary has no `ENDNOTE` and no `TEXTBOX`. Filing note or
text-box content under `PARAGRAPH` would let a rule about body text fail
because of a footnote — exactly the abuse the schema-evolution rule warns
about. So Phase 6 introduces **fact schema version 2**, which adds those two
element types and nothing else.

- Version 1 remains valid for ever and keeps its own vocabulary. A fact set
  declaring version 1 may not use the new types, enforced by a version-aware
  check in both the TypeScript and Python validators.
- Phase 4's golden fixtures are unchanged and still pass.
- The rule engine accepts both versions (`SUPPORTED_FACT_SCHEMA_VERSIONS`).
- Rules may name the new element types at any version: a rule that selects
  nothing is already a meaningful answer.
- Published standards are unaffected; no rule content and no content hash
  changes.

## 9. What the analyzer extracts

Sections and page setup (per section, never averaged): page size, orientation
as declared, the four margins, header and footer distance, gutter, column
count, section break type. A `w:sectPr` inside a paragraph _closes_ the section
that paragraph is in; the one at body level closes the last. Mirrored margins
turn left and right into inside and outside, so those two facts drop to PARTIAL.

Paragraphs: style, alignment, line spacing with its mode, spacing before and
after, first-line and hanging indent, start and end indent, keepNext,
pageBreakBefore, text direction, outline level.

**Line spacing keeps its semantics.** `auto` is a multiple of a line (240ths,
so 360 is exactly 1.5); `exact` and `atLeast` are physical lengths. The mode
travels with the value so a rule never compares a multiplier with a length.

Runs: font family per channel, size per channel, bold, italic, underline,
colour, highlight, language, RTL.

Headings: from the **effective outline level** only (0–8 → heading 1–9). Never
from boldness or size, and never from a localized style _name_, which can be
customized or translated.

Numbering: level, format, start value and effective indentation, resolved
through `w:num` → `w:abstractNum` with `w:lvlOverride` and `w:startOverride`
applied — so two paragraphs sharing an abstract definition can legitimately
differ. The analyzer does not render number text.

Tables: rows, columns (widest row, `gridSpan` included), alignment, absolute
width, nested tables with their own locators. **Conditional table-style
formatting** (first row, banded rows) is _not_ resolved; that drops the table
domain to PARTIAL with a warning, because an honest partial answer beats a
confident wrong one.

Headers and footers: default, first-page and even-page, with section
inheritance applied. A first-page header is read only when `w:titlePg` is set;
an even-page header only when `w:evenAndOddHeaders` is.

Notes: footnotes and endnotes as separate stories, with Word's separator notes
excluded from user counts.

Fields: `PAGE`, `NUMPAGES`, `TOC`, `SEQ`, `CITATION`, `REF`, `STYLEREF`,
`HYPERLINK`. Instructions are **data** and are never executed; a cached result
is never evidence of a rendered fact. `tableOfContentsPresent` says a TOC field
exists, not that it is current.

Captions: recognized only from a `SEQ Figure`/`Table`/`Equation` field, never
from "text under an image". The caption domain is always PARTIAL.

Figures and equations: DrawingML extents in EMU converted exactly, inline
versus anchored, alt-text presence; `m:oMath` counted without interpretation.

Metadata: title, subject, creator, keywords, description, language, created,
modified — under `METADATA` scope, never mixed with body facts.

## 10. Word count

There is no universal word count, so PalCert defines its own and versions it
with the analyzer:

- Counted from the FINAL revision view; hidden text excluded.
- Reported per story: body, footnotes, endnotes, headers and footers, text
  boxes. `bodyWordCount` is the main story alone; `wordCount` maps to it.
- A word is a maximal run of Unicode letters or digits, with `'`, `’`, `-`,
  `_` and tatweel joining two word characters, and `.`/`,` joining two digits.
  So "state-of-the-art" and "3.5" are one word each.
- Arabic counts naturally: Arabic letters are letters, and diacritics are
  combining marks that never split a word.
- CJK is counted per whitespace-delimited run, not per character.

Changing this algorithm changes what PalCert has measured, so it is an
analyzer-version decision rather than a tweak.

## 11. Coverage

Coverage is declared deliberately, never defaulted:

| Domain                                | Status                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PAGE` (any)                          | UNAVAILABLE — not stored in the file                                                                                                |
| `DOCUMENT/pageCount`                  | UNAVAILABLE — a saved count is a stale hint                                                                                         |
| `ELEMENT/CITATION`, `REFERENCE_ENTRY` | UNAVAILABLE — semantic, not structural                                                                                              |
| `ELEMENT/CAPTION`                     | PARTIAL — SEQ fields only                                                                                                           |
| `ELEMENT/TABLE`                       | PARTIAL when conditional style formatting is unresolved                                                                             |
| formatting domains                    | PARTIAL on a style cycle, missing parent or unsupported markup                                                                      |
| font family / size properties         | PARTIAL for the affected element type and property when visible final text has a missing value; other formatting guards still apply |
| everything else read completely       | COMPLETE                                                                                                                            |

Exact OOXML extraction carries `sourceKind: OOXML` and **no confidence**:
inventing 1.0 for an attribute read would make a meaningless number look
measured.

## 12. Determinism

The same bytes and the same analyzer version produce the same artifact bytes.
Facts are sorted canonically by scope, then location, then value; warnings are
sorted; JSON is serialized with sorted keys and fixed separators; every number
is an integer or an exact decimal string. `artifactSha256` is computed over
exactly the bytes that are stored — there is no second "canonical form" to
argue about later.

Three hashes exist and mean different things: `DocumentVersion.sha256` (the
user's file), `DocumentAnalysis.artifactSha256` (the derived artifact) and
`StandardVersion.contentHash` (published rules).

## 13. Orchestration

`ensureDocxAnalysis(documentVersionId)` returns a compatible analysis or
creates and queues one. Compatible means the same version, analyzer name,
analyzer version and fact-schema version. A partial unique index over the live
states makes it idempotent in the database, so concurrent callers race safely.

Analysis is **on demand**: no upload is analyzed automatically. Phase 7 calls
this when a user requests a check.

Jobs reuse Phase 5 entirely — the transactional outbox, the `processing_jobs`
ledger, BullMQ delivery, database leases, heartbeats and the jittered retry
policy — with one new job type, `DOCX_ANALYSIS`. Delivery is at-least-once:
claiming is atomic, so a duplicate delivery is a no-op.

Failures are classified. A `DOCUMENT_*` code describes the file and will
recur identically, so it is recorded and the job succeeds — deciding "this
cannot be analyzed" _is_ the job's work. An `ENGINE_*` or `STORAGE_*` code is
transient and spends an attempt.

## 14. Privacy

An artifact inherits its source document's sensitivity exactly.

- It lives in a third private bucket, versioned and encrypted, with **no CORS
  and no presigned URL**: no browser reaches it
  ([ADR-0042](../adr/0042-derived-artifact-storage.md)).
- The database stores identity, integrity and counters. Never text.
- Logs and metrics carry counts, codes and durations. Never body text,
  headings, comments, metadata values, filenames or full digests.
- Paragraph text _is_ retained inside the artifact, bounded per paragraph,
  because Phase 7 report localization and Phase 12 SmartFix need it to anchor
  an edit. That is the documented exception, and it is why the artifact is
  private, encrypted and purged with its source.
- Comment text is never extracted at all: presence and count only.

## 15. Deliberate boundaries

The analyzer does not know which university, journal or standard a document is
for, and must not: one analysis is reusable against every standard. It does not
decide semantic sections ("this is the Abstract"), does not render, does not
modify the DOCX, does not read PDFs, and never emits a PASS, a FAIL or a score.

## 16. Configuration

`DOC_ENGINE_URL`, `DOC_ENGINE_ANALYSIS_TIMEOUT_MS`,
`DOC_ENGINE_READINESS_TIMEOUT_MS`, `ANALYSIS_MAX_SOURCE_BYTES`,
`ANALYSIS_MAX_ARTIFACT_BYTES`, `STORAGE_DERIVED_BUCKET`. Production requires
three distinct buckets and encryption at rest.

## 17. Runbook

| Symptom                            | Where to look                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Analyses stuck in PENDING          | Is a worker running? Is Redis up? `SELECT status, attempt_count, last_failure_code FROM processing_jobs WHERE job_type = 'DOCX_ANALYSIS'` |
| `ENGINE_UNAVAILABLE` failures      | The Python analyzer is down or unreachable; the worker's readiness probe reports `document-analysis`                                      |
| `DOCUMENT_SOURCE_INTEGRITY_FAILED` | The clean object does not match the version digest. Investigate the object, never re-point the analysis                                   |
| `DOCUMENT_TOO_COMPLEX`             | A documented analyzer limit was hit; the failure detail names which                                                                       |
| Coverage unexpectedly PARTIAL      | Read `warning_codes` on the analysis row                                                                                                  |
| Artifact missing                   | `artifact_object_key` is null unless the analysis succeeded; a succeeded row without one is impossible by check constraint                |

### Analyzer version 6 deployment

Deploy the API, worker and document-engine images from the same release: the
API/worker select `palcert-docx` version `6`, and the engine emits that version.
Historical analyses and reports are immutable. Start a new check after rollout
so it requests a version 6 analysis, then create a new SmartFix plan from that
report. Retrying an existing plan does not refresh its source analysis.

The SmartFix acceptance gate is unchanged: every targeted rule must pass or be
not applicable, and a previously passing rule must not regress. Incomplete
evidence still yields `INDETERMINATE`; it is never converted to `PASS` merely
because the extracted facts contain no violations.

## The other analyzer

Phase 13 added a PDF analyzer alongside this one. The two share the artifact
envelope, the fact schema and the whole orchestration; nothing in this document
changed to accommodate it, and historical DOCX artifacts keep their hashes. The
differences — and they are large, because a DOCX records instructions and a PDF
records results — are in [`pdf-analysis.md`](pdf-analysis.md).
