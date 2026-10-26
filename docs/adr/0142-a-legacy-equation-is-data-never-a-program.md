# ADR-0142: A legacy equation is data, never a program

- **Status:** Accepted
- **Date:** 2026-09-26
- **Phase:** UI completion (post-RC)

## Context

An institution uploaded its PhD thesis template as a standard source
("Template (Word)", "Primary") and the ingest worker refused it with
`FILE_EMBEDDED_OBJECT_UNSUPPORTED`. The template carries one equation written
with MathType — an OLE object of class `Equation.DSMT4` — numbered `(3.1)`, as
thesis templates do.

The DOCX container policy (§16) rejected *every* part under
`word/embeddings/` and every `oleObject` content type, without looking at what
the object was. That was the right default for an MVP: an OLE object is how
an executable, an Office file or an ActiveX control gets into a Word document,
and PalCert never needs to open one. It is the wrong answer for scientific
writing, where legacy equation objects are ordinary — and an academic
compliance system that refuses the thesis it exists to check is not safe, it
is useless.

The same pipeline ingests a student's thesis and an institution's guideline
(ADR on the shared pipeline, Phase 9 §9), so the decision applies to both.

## Decision

1. **Classify, then decide — per object, never per document.** An embedded
   object is accepted only when every structural signal agrees:
   - an internal `oleObject` relationship targets `word/embeddings/*.bin`;
   - an `<o:OLEObject Type="Embed">` inside a `<w:object>` in that part's
     own XML uses the relationship, with a ProgID on an explicit allow-list;
   - the bytes parse, with a bounded and loop-checked reader, as a
     well-formed OLE compound file whose root CLSID is the one registered for
     that ProgID;
   - its `CompObj` stream names the same ProgID;
   - it holds an `Equation Native` stream whose EQNOLEFILEHDR is consistent;
   - it holds no storages and no streams beyond an equation's own
     (`CompObj`, `Ole`, `ObjInfo`, `Equation Native`, `OlePres###`,
     `EPRINT`) — never `Ole10Native`, the Packager wrapper for an arbitrary
     file.
2. **The allow-list is short and explicit:** `Equation.DSMT4` (MathType,
   `{0002CE03-…}`) and `Equation.3` (Microsoft Equation 3.0, `{0002CE02-…}`).
   Adding a class is a security decision recorded here, not a convenience.
3. **Unknown means rejected, as before.** Anything that fails a check —
   another class, a packaged executable claiming to be an equation, an
   embedded Office file, a linked object, a malformed container, an orphaned
   embedding, a relationship escaping `word/embeddings`, an embedded package —
   is `FILE_EMBEDDED_OBJECT_UNSUPPORTED`. ActiveX controls, which the old
   policy did not name, are now rejected explicitly.
4. **Nothing is executed, rendered or converted.** No COM, no Word, no
   Equation Editor, no MathType, no external process, no file written from
   the object; no CLSID or ProgID is ever resolved to a program. The
   document engine never opens `word/embeddings/` at all (a test spies on the
   ZIP reader to prove it); only the API's classifier reads the bytes, as
   untrusted data, within the inspected-part limit.
5. **The equation stays in the document.** The engine records a recognized
   legacy object as an *equation* (not a picture): its reading order, its
   paragraph, the number printed beside it, whether a preview picture exists,
   and `semanticsAvailable: false` with the warning
   `LEGACY_EQUATION_SEMANTICS_UNAVAILABLE`. OMML equations carry the same
   placement fields. Rule extraction gives the model an explicit marker —
   "[Equation (3.1): legacy Equation.DSMT4 object, processed in safe mode;
   mathematical content not available]" — instead of dropping the paragraph.
6. **Say what happened.** A source records how many legacy equations it
   accepted (`legacy_equation_count`, immutable once READY) and the UI states
   that they were processed in safe mode. A rejection states its reason.

## Alternatives considered

- **Strip the equations, or convert the document to PDF, and accept the
  rest.** Destroys what the rules are about (equation presence, numbering,
  placement) and makes PalCert's copy differ from the author's.
- **Accept any OLE object that has a preview picture.** A preview is a
  picture anyone can attach to any payload; it proves nothing about the
  object.
- **Trust the ProgID in `document.xml`.** It is one attribute in XML the
  uploader wrote. The classifier treats it as a claim and checks it against
  the compound file's own CLSID and `CompObj`.
- **Parse MTEF into mathematics now.** Useful later, but it is a parser for an
  untrusted binary format with a history of exploitation in the program that
  wrote it; not needed for placement and numbering rules, and not part of
  this change.

## Consequences

- Theses and templates with MathType or Equation 3.0 equations are accepted;
  `equationCount` includes them and `figureCount` no longer does, so the DOCX
  analyzer version moves to 5 and a version 4 analysis is not reused.
- The classifier is new attack surface: a small, bounded compound-file reader.
  It is exercised with valid, truncated, looping and oversized containers, and
  cross-checked against an independent parser during development.
- An equation class outside the allow-list (for example an older MathType
  `Equation.DSMT` variant) is still refused until it is added here with
  evidence of its structure.
