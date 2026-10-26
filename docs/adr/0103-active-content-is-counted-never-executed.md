# ADR-0103: Active content is counted, and nothing in a PDF is ever executed or fetched

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

A PDF can carry JavaScript, launch actions naming executables, URI actions
naming remote hosts, remote go-to actions, rich media, embedded files, and an
`/OpenAction` that runs on open. Standards legitimately ask about some of these
— "the submitted file must contain no embedded files" is a reasonable rule.

Answering those rules requires finding them. It does not require running them,
and the distinction is the whole of PalCert's exposure here. A parser that
resolves a URI action is an SSRF primitive that any user can aim at PalCert's
internal network by uploading a document. A parser that opens an embedded file
is parsing a second piece of untrusted input the user chose.

## Decision

**PalCert walks the inventory and touches nothing in it.**

- JavaScript, launch actions, URI actions, remote go-to actions, rich media,
  attachments and signature fields are counted. Nothing is executed, followed,
  fetched, launched or resolved.
- The child process has no network access and writes no files (`RLIMIT_FSIZE`
  of 0), so the refusal is structural as well as behavioural.
- **Targets are not recorded.** A URI's host, a launch action's path and an
  attachment's filename do not reach the artifact, the headers, the logs or the
  metrics. A target PalCert never touches is a target it never needs to store,
  and an attachment name is user content. The test suite asserts the fixture's
  URL, executable path, script body and attachment name appear nowhere in the
  output.
- An embedded file's *bytes* are never opened. Only that one exists, and how
  many.

## Alternatives considered

**Record targets so the report can show them.** Useful to a user, and it puts
attacker-controlled strings into logs, metrics labels and a rendered report.
The count answers every rule PalCert has seen; showing the URL answers none of
them better.

**Resolve URIs to report broken links.** A link checker driven by untrusted
input, running inside PalCert's network. No.

**Scan attachments with ClamAV.** Phase 5 already scans the uploaded file, and
the archive is scanned as a whole. Extracting and re-scanning inside the
analyzer would mean the analyzer writes files, which it does not.

## Consequences

- Rules about active content are answerable, precisely.
- A hostile PDF gains nothing by embedding a target: PalCert counts it and
  forgets it.
- A user asking "which link?" cannot be told. That is a deliberate trade, and
  the count is what the standards actually ask about.
