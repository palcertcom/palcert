# ADR-0098: pypdfium2 and pikepdf, chosen on licence before capability

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

The most convenient Python PDF library is PyMuPDF. It renders, extracts text,
reads structure and reports geometry, all through one well-documented API, and
it would have been the fastest route to a working analyzer.

PyMuPDF binds MuPDF, which is AGPL-3.0 unless a commercial licence is bought
from Artifex. AGPL's network clause reaches a hosted service: PalCert is
software users interact with over a network, and shipping PyMuPDF without a
commercial licence would oblige PalCert to offer its complete corresponding
source to every user. That is a decision about the whole product, taken by
whoever adds one line to `pyproject.toml`.

## Decision

**Licences are reviewed before a PDF dependency is added, and PyMuPDF is not
added.**

The engines, pinned exactly:

| Package | Version | Licence |
|---|---|---|
| `pypdfium2` | 5.13.0 | Apache-2.0 / BSD-3-Clause |
| PDFium (bundled) | 153.0.7999.0 | BSD-3-Clause |
| `pikepdf` | 10.13.0.post1 | MPL-2.0 |
| qpdf (bundled) | 12.3.2 | Apache-2.0 |

None is copyleft in a way that reaches PalCert's own source. Licences were read
from the installed wheel metadata rather than from memory.

The split of work follows from what each is good at, not from having two:
pikepdf reads the file's own statements — catalog, metadata, structure tree,
inventory of active content. PDFium renders and measures — page geometry, glyph
boxes, fonts, images. Neither is asked to do the other's job.

Versions are pinned exactly, including the native engines, because analyzer
output is stored and re-read for years: a minor PDFium release that rounds a
glyph box differently would change stored geometry and therefore report hashes.
The engine versions are recorded in every artifact.

## Alternatives considered

**Buy a PyMuPDF commercial licence.** A real option, and a recurring cost and a
vendor relationship to justify before PalCert knows whether PDF checking earns
anything. It stays available later; nothing here forecloses it.

**pdfminer.six alone.** Pure Python, permissive, and slow on large documents,
with no renderer — which the corpus needs for glyph geometry.

**PDFium alone, without pikepdf.** PDFium does not expose the structure tree
usefully, nor /UserUnit, nor the attachment and action inventory. The second
library is doing real work.

## Consequences

- No strong-copyleft obligation is introduced into PalCert.
- Two libraries to keep current instead of one, each pinned and each recorded in
  the artifact.
- An upgrade to either is a deliberate change with a golden-corpus diff, not a
  routine dependency bump.
