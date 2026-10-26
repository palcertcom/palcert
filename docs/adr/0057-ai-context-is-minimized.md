# ADR-0057: PalCert sends selected evidence, never the document

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

The easiest implementation sends the whole manuscript and lets the model find
what it needs. It is also the worst one available: it maximizes what leaves
PalCert, maximizes what it costs, and maximizes the amount of a stranger's
unpublished research sitting in a third party's logs — in exchange for
convenience in a context builder.

## Decision

PalCert never sends the file. It never sends raw ZIP bytes or OOXML internals.
It sends a normalized **context bundle** built from the Phase 6 structural
model:

- a heading outline, for orientation;
- the paragraphs selected as relevant to the requested rules, by bilingual
  keyword and heading proximity;
- bounded metadata (counts, declared author/title/company where a rule needs
  them);
- the deterministic findings for the rules being assessed.

Everything is bounded: characters per node, nodes per bundle, characters per
bundle, rules per request. When the bundle is cut, the truncation is **stated
to the model** — reason and dropped-node count — and the prompt instructs it to
answer `INSUFFICIENT_EVIDENCE` rather than infer material nobody supplied.

Nothing about PalCert's own infrastructure goes in the bundle: no API keys, no
database or storage credentials, no signed URLs, no service tokens, no session
identifiers.

## Alternatives considered

**Send the whole document.** Rejected, as above.

**Silently drop context that does not fit.** Rejected, and it is the more
dangerous option of the two: a model told it has the whole document when it has
a quarter of it will conclude confidently about evidence that was never sent.

## Consequences

- Requests stay small and predictable, so cost is a function of the standard's
  size rather than the thesis's.
- A requirement whose evidence was cut is answered "not enough evidence",
  which is correct, rather than guessed, which is not.
- A rule that needs material the selector misses degrades to
  `INSUFFICIENT_EVIDENCE` — a visible, fixable failure rather than a wrong
  answer.
