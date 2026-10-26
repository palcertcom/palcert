# ADR-0095: Every PDF analysis runs in its own bounded child process

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

A PDF is untrusted input handed to a large body of C++ that renders it. PDFium
is the engine Chrome uses, which makes it about as well-tested as this software
gets, and it is still parsing adversarial input. A crash is not hypothetical; a
runaway allocation on a deliberately malformed file is not hypothetical either.

PDFium is also not thread-safe, and its handles must not cross threads.

If the analyzer runs in the FastAPI worker process, a single hostile document
takes down every analysis in flight, including other users'.

## Decision

**One analysis, one process, killed on a deadline.**

- `app.pdf.isolation.run_isolated` spawns `python -m app.pdf.worker` with the
  document on stdin and one JSON document on stdout. No shared state of any
  kind, so PDFium handles never cross a thread boundary — the process owns
  everything in it.
- The child applies `RLIMIT_AS` (3 GB), `RLIMIT_CPU`, `RLIMIT_FSIZE` of 0 (it
  writes no files) and `RLIMIT_CORE` of 0 (a core dump of a PDF parse would
  contain the document) to itself before importing the parser.
- The parent enforces the wall clock, because a hung child cannot time itself
  out. `subprocess.run` kills and reaps, so a timeout leaves no zombie.
- Three outcomes are all ordinary: an artifact, a clean error with a stable
  code, or a crash the parent turns into `PDF_ANALYZER_CRASHED` /
  `PDF_ANALYSIS_TIMEOUT`. A paid check treats all three identically — no
  report, no charge, reservation released.
- The child's error detail is the exception *type*, never its message: a parser
  error can quote document content, and error strings reach logs.
- Limits travel with the request, so a caller's budget is the budget the child
  enforces rather than being silently replaced by the default.

## Alternatives considered

**In-process with a signal-based timeout.** Does not survive a segfault, and a
segfault is the case this exists for.

**A pool of long-lived parser processes.** Faster, and it reintroduces shared
state between documents — the thing that makes one hostile file everyone's
problem. Measured cost of a fresh process is ~0.14 s for an ordinary document,
which is not worth that.

**Containers per analysis.** Stronger, and an operational dependency PalCert
does not otherwise have.

## Consequences

- A parser crash fails one analysis. The suite proves it by running a good
  document immediately afterwards in the same parent.
- Startup cost is paid per analysis. Acceptable at the scale checks run.
- Resource limits are enforced where the resources are actually consumed.
