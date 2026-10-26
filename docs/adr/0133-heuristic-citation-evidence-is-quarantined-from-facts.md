# ADR-0133: Heuristic citation evidence is quarantined from facts

- **Status:** Accepted
- **Date:** 2026-09-19
- **Phase:** 18

## Context

Through Checkpoint 9, PalCert's PDF citation analysis read only what an author
declared: `/Reference`, `/BibEntry`, `/Lbl`, link annotations with internal
destinations. That is exact evidence and it is the right foundation. It is also
absent from most real documents — a thesis exported from a word processor has a
complete, numbered, perfectly legible reference list and no structure tree at
all, and PalCert reported an empty citation graph for it.

Recovering that structure means classifying rather than reading, which is the
thing every earlier citation checkpoint refused to do. The danger is not that a
detector is sometimes wrong; it is that a wrong answer becomes indistinguishable
from a declaration by the time it reaches a verdict. The deterministic engine
evaluates FAIL before it consults coverage, so a heuristic value that is wrong
fails a compliant document and no coverage status prevents it.

## Decision

**Heuristic discovery ships, and nothing it produces may become a fact.**

Every object the detector creates carries `sourceKind: HEURISTIC` and a
`confidence`. The two projected PDF citation properties are exact kinds — an
`EXACT_ELEMENT_VALUE` and an `EXACT_POSITIVE_MARKER` — so each is gated
independently, three ways, rather than relying on one filter:

* the linker gives **exact** citations an index of **declared** entries only,
  so a heuristic entry can never become the target that decides a declared
  citation's `resolutionStatus`;
* the projector filters the citation list to `sourceKind: PDF_TEXT`, and takes
  the declared citations as the coverage population;
* `referenceRegionPresent` requires the `REFERENCE_REGION` coverage domain, the
  `summary.referenceRegionObserved` flag **and** a declared entry's own
  provenance, each of which is declared-only.

No public heuristic property is added and `document-property-support.json` is
unchanged. Projecting heuristic evidence is a separate decision, to be taken
deliberately and not inherited from this checkpoint.

**Exact evidence always wins the merge.** A heuristic candidate whose spans are
already claimed by a declared element is dropped, not merged. The overlap test
is span node identity: a span is the one the author stamped or it is not, so
there is no threshold and nothing to tune. Exact objects keep their ids,
ordinals, provenance and links, and heuristic ones are appended after them, so
adding this layer cannot renumber an artifact somebody already stored.

**Confidence describes the observation and licenses nothing.** It never
promotes an AMBIGUOUS link to LINKED, never overrides an exact object, and the
semantic integrity pass never reads it. It comes from one table of named,
fixed-weight signals; it is monotone in the signal set; and it is scaled by a
ceiling below 1, because the signals are the evidence this detector knows how
to look for rather than the evidence that exists.

**Coverage moves only as far as the detector earned.** `SEMANTIC_CITATIONS` and
`SEMANTIC_REFERENCE_ENTRIES` leave `NOT_IMPLEMENTED` for an untagged document
only when objects were actually produced, and then only to `PARTIAL`. Scanning
every span is not recognizing every citation style.

## Alternatives considered

**Add a parallel `heuristicCitations` section.** It would make the quarantine
structural rather than a property on each object. Rejected: the links, the
`cited-by` counts and the resolution graph would have to be duplicated or
cross-referenced between two collections, and a reader would have to merge them
to answer any question — which is the merge this checkpoint is trying to keep
in one deterministic place.

**Project heuristic evidence under a confidence threshold.** A threshold is a
tuning parameter, and a tuned number deciding a compliance verdict is exactly
what Phase 18 has refused since Checkpoint 2. It also misreads what confidence
is: a belief about whether a marker was *recognized*, not about whether the
document complies.

**Widen the exact properties to cover recognized citations.** The same mistake
Checkpoint 9 declined to make with `nativeSourceResolved`, for the same reason:
it silently redefines what a property already promises every rule author.

## Consequences

The PDF analyzer moves to `6.0.0`, because a readable untagged PDF now produces
a citation graph where every earlier version produced an empty one. The DOCX
analyzer stays at `4`: its output did not change, and bumping it would
re-analyze every stored DOCX for nothing.

No contract, schema or registry changed. `confidence` was already optional on
`CitationOccurrence` and `ReferenceEntry` and already forbidden on non-heuristic
evidence by the integrity pass, so "every heuristic object carries a
confidence" is enforced as an analyzer producer invariant with tests rather
than by tightening the shared schema — an older artifact without one is still a
valid artifact.

A finding about an untagged PDF's citations is not yet possible, and that is
intended. What exists now is an evidence panel's worth of honest, bounded,
provenance-tagged observation, and a clear place to stand when deciding whether
any of it should ever be allowed to decide something.
