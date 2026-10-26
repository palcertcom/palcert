# PDF analysis

How PalCert reads a PDF, what it can and cannot conclude from one, and why the
boundaries are where they are.

The companion document is [`docx-analysis.md`](docx-analysis.md). The two
analyzers share an envelope, a fact schema and an orchestration, and almost
nothing else — because the two formats record almost entirely different things.

## The shape of it

```
READY PDF DocumentVersion
  → source integrity verification (SHA-256, before any parser)
  → bounded child process
      ├─ pikepdf/qpdf  : the file's own statements
      └─ PDFium        : rendering and measurement
  → PdfStructuralModel
  → DocumentFactSet (Fact Schema v2)
  → the existing deterministic rule engine
  → the existing paid check workflow
  → an immutable PalCert technical report
```

Everything from the fact set onwards is Phase 6's machinery, unchanged. PDF is a
second way of producing facts, not a second way of checking them.

## What a PDF is, for this purpose

A DOCX records **instructions**: this paragraph uses the Heading 1 style, this
section has a 25 mm left margin, this run is bold. A PDF records **results**:
this glyph is at (72.0, 700.4) in this font at this size, this image covers this
rectangle.

Almost every difference in this document follows from that one sentence.

| Question | DOCX | PDF |
|---|---|---|
| How many pages? | Not stored — the renderer decides | **Authoritative**: the page tree is the pagination |
| What is the left margin? | **Exact**: a stored property | Not stored. PalCert measures where ink starts, which is a different thing ([ADR-0094](../adr/0094-observed-inset-is-not-a-margin.md)) |
| Which text is a heading? | **Exact**: the paragraph's style | Only if the PDF is tagged ([ADR-0093](../adr/0093-tagged-structure-binds-through-marked-content.md)) |
| What size is the body text? | **Exact**: a run property | **Exact**: the text state size, after the matrices |
| Can it be corrected? | Yes, SmartFix | **No** ([ADR-0092](../adr/0092-pdf-is-an-inspection-format-not-a-smartfix-format.md)) |

The full table is `contracts/registries/document-property-support.json`, which is
the single source of truth: the Python analyzer, the TypeScript API and the UI
all read that one file, so the analyzer's behaviour and the preview the user
sees before paying cannot drift apart.

## The engines

| Package | Version | Licence | Job |
|---|---|---|---|
| `pypdfium2` | 5.13.0 | Apache-2.0 / BSD-3-Clause | render, measure |
| PDFium | 153.0.7999.0 | BSD-3-Clause | (bundled) |
| `pikepdf` | 10.13.0.post1 | MPL-2.0 | read the file's own statements |
| qpdf | 12.3.2 | Apache-2.0 | (bundled) |

Licences were reviewed before either was added; PyMuPDF was rejected on its AGPL
obligation ([ADR-0098](../adr/0098-licence-review-before-a-pdf-dependency.md)).
All four versions are pinned exactly and recorded in every artifact, because a
minor renderer release that rounds a glyph box differently would change stored
geometry and therefore report hashes.

ISO 32000-2:2020 is the reference for PDF semantics. Where this document cites a
clause, it means that specification — not one library's behaviour, which is an
implementation and can be wrong.

## Isolation

Every analysis runs in its own child process with its own address-space, CPU and
file-size limits, killed on a wall-clock deadline by the parent
([ADR-0095](../adr/0095-analysis-runs-in-a-bounded-child-process.md)). No
network, no filesystem, no shared state — which is also what keeps PDFium
handles off thread boundaries, since PDFium is not thread-safe.

A parser crash fails one analysis. It does not fail the service, and the test
suite proves it by analyzing a good document immediately afterwards in the same
parent.

## Source integrity

The first thing that happens, before any parser sees a byte, is that the SHA-256
of the retrieved bytes is compared with the digest the DocumentVersion recorded
in Phase 5. A mismatch is `DOCUMENT_SOURCE_INTEGRITY_FAILED` and nothing is
parsed. Only the exact promoted clean object version is read — never the latest
version of the key, never the quarantine object, never a path from a request.

## Geometry

A PDF page has five boxes — MediaBox, CropBox, BleedBox, TrimBox, ArtBox — and
they are not interchangeable. PalCert records all five, which one it treated as
effective, the rotation, and `/UserUnit` (which scales user space and which a
reader that assumes 1.0 will describe an A0 plan as an A4 sheet).

Two coordinate systems are carried, both versioned:

- `rawPdfBBox` — PDF user space, origin bottom-left, as the file stores it.
- `displayBBox` — origin top-left, rotation applied, as a reader sees it.

Every number is a canonical decimal string, quantised with ROUND_HALF_EVEN to a
fixed number of places, so two floats differing in their last bits serialise
identically and the artifact hash does not move with the C library's mood.

## Text, and what a span is

PDFium yields characters. PalCert groups them into **spans** — runs sharing a
font, an effective size, a baseline and a marked-content id. That is the
smallest grouping still *read* from the file, so spans carry `PDF_TEXT`
provenance.

The effective font size is the text-state size multiplied by the vertical scale
of the text matrix (`hypot(b, d)` from `FPDFText_GetMatrix`). Text set at 10pt
under a 2× matrix renders at 20pt, which is what a ruler measures and what a
typography rule means.

Spans are grouped into **lines** (shared baseline) and **blocks** (vertical
proximity plus horizontal overlap). Those carry `PDF_LAYOUT` provenance and are
produced by a versioned algorithm. A block is called a block everywhere — in the
model, in the facts, in the report — and never a paragraph, because a PDF does
not record where the author pressed Enter.

## Semantics

A **tagged** PDF declares its structure, and PalCert uses it. Binding is through
the marked-content id: each span records the id of the text object it came from,
each structure element records the ids its `/K` entry names, and those are the
same integers written by the author's software. An identity, not a resemblance.

An **untagged** PDF gets no HEADING, TABLE, FIGURE, CAPTION or LIST facts at
all. Large bold centred text is large bold centred text; ruling lines are ruling
lines; an image under a caption is an image under a caption. Coverage for those
element types is reported UNAVAILABLE with the reason, and rules about them are
INDETERMINATE ([ADR-0093](../adr/0093-tagged-structure-binds-through-marked-content.md)).

A typical untagged thesis therefore has thinner semantic coverage than the same
thesis as a DOCX. This is deliberate, and the compatibility preview says so.

## Scans

Pages are classified `NATIVE_TEXT`, `IMAGE_ONLY`, `HYBRID` or
`EMPTY_OR_UNKNOWN` by a versioned classifier, from counted evidence: mapped
characters, unmapped characters, and the largest single image's share of the
page (largest, not the sum — a page tiled with figures is not a scan).

**There is no OCR** ([ADR-0096](../adr/0096-no-ocr-in-phase-13.md)). An
image-only page yields page geometry and no typography, and the coverage note
says "no OCR was performed" in those words. One scanned page in an otherwise
searchable document makes the document HYBRID, not "mostly searchable": coverage
is per page so that one page's limitation is not averaged away.

## Metadata

XMP and DocumentInfo are both read, both kept, and compared. XMP wins where they
disagree, the chosen source is recorded per field and travels into fact
provenance, and the disagreement raises `PDF_METADATA_CONFLICT` naming the
fields — never the values, because a warning reaches logs and a title is user
content ([ADR-0097](../adr/0097-metadata-provenance-is-preserved.md)).

A `pdfaid:part` claim is recorded as `claimedPdfAPart`. PalCert is not a PDF/A
validator and never reports conformance
([ADR-0102](../adr/0102-signature-and-pdfa-claims-are-not-verdicts.md)).

## Active content and encryption

JavaScript, launch actions, URI actions, remote go-to actions, rich media,
attachments and signature fields are **counted**. Nothing is executed, followed,
fetched, launched or resolved, and no target — URL, executable path, attachment
name — is recorded anywhere
([ADR-0103](../adr/0103-active-content-is-counted-never-executed.md)).

A password-protected PDF is `PDF_PASSWORD_REQUIRED`. PalCert does not collect a
password, does not try the empty owner password, and does not brute-force. The
check fails and **nothing is charged**.

## Buying a PDF check

Before payment, `GET /catalogue/standards/:id/compatibility?documentVersionId=…`
compares the standard's rules with what the document's detected format can
answer. It is free and does not open the document.

- **Partial** coverage is sold, with the unanswerable rules listed.
- **Zero** coverage is refused with `CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT`,
  before the reservation — not refunded afterwards
  ([ADR-0100](../adr/0100-a-zero-coverage-standard-is-refused-not-sold.md)).

Supported is not a promise of a verdict: a fully supported standard can still
come back INDETERMINATE on a scan. The UI says so.

## Determinism

The same bytes and the same engine versions produce a byte-identical artifact.
Fonts are emitted in sorted order, warnings in sorted order, node ids are derived
from position (`page:1/textobj:17` — no UUID, no database sequence, no
timestamp), and every number is quantised before serialisation. There are no
numeric confidence scores anywhere: PalCert states what it read, or says it could
not read it.

## Privacy

Document text, metadata values, attachment names, bookmark titles, author, title
and raw parser output never reach a log line, a metric label, an audit event or
an HTTP header. The artifact holds them and lives in `palcert-derived` under the
same user-scoped RLS as every other derived object. Warning details carry counts
and identifiers only.

## The corpus

`services/document-engine/tests/pdf/builder.py` constructs every fixture from
raw PDF objects rather than checking in binaries: the expected value is
derivable, a failure localises to forty readable lines, and nothing arrives
unexamined. Arabic and RTL fixtures are mandatory and present, including a
composite font with and without a ToUnicode CMap.
