# ADR-0063: Extraction is two passes — citations first, structure second

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 9

## Context

Phase 9 needs two things from a model that a single request cannot give:

1. **Grounding.** Every extracted requirement must be traceable to an exact
   passage of an exact source document, so a reviewer can check it and so an
   accepted rule carries provenance. That is what the provider's citations
   feature produces — structured `page_location`, `char_location` and
   `content_block_location` data that PalCert can verify against what it sent.
2. **Structure.** A proposal must arrive as a constrained object drawn from
   PalCert's own rule vocabulary, not as prose to be parsed (ADR-0059).

The current Anthropic API cannot serve both in one request: citations and
`output_config.format` are mutually exclusive, and combining them returns a
400. This is not a preference — it is a property of the API PalCert targets.

Parsing citations out of a structured response is not a workaround either. A
model can write a page number into a JSON field; only the citation machinery
can attest that the text actually came from that page.

## Decision

Extraction runs as two provider calls with separate contracts.

**Pass A — evidence discovery.** Citations on, no structured output, no tools.
PDFs go as base64 `document` blocks; DOCX sources go as `ContentBlockSource`
text blocks, one block per PalCert structural node, so a returned
`content_block_location` maps positionally back to an exact node id. PalCert
keeps **only** the citation data: the quoted span, its locator, and which
source it came from. The model's surrounding prose is discarded, because
ungrounded model text is not evidence.

**Pass B — rule structuring.** Structured output on, citations off, no tools,
and **no source document**. Pass B reads only the evidence Pass A grounded plus
the deterministic template observations, and returns proposals against PalCert's
JSON schema.

Block locations are inclusive-start, exclusive-end, matching the provider's own
`content_block_location` semantics; a citation outside the range PalCert
supplied is discarded as ungrounded rather than trusted.

The two-pass split is asserted structurally: the provider adapter has no code
path that sets `citations` and `output_config.format` on the same request, and
the optional live smoke test proves it against the real API, where a violation
would surface as a 400.

## Alternatives considered

**One request, parse citations from the JSON.** Rejected: it would let the
model assert its own provenance, which is precisely what §55 forbids.

**Skip citations, trust the prose.** Rejected: an unverifiable quotation cannot
support an accepted rule, and a reviewer would have nothing to check.

**Use the Files API to upload guidelines once.** Deliberately not used. Sending
bytes per request keeps PalCert's retention story simple and avoids a
provider-side object PalCert would then have to manage, and no client-supplied
`file_id` is ever accepted.

## Consequences

- Two invocations per run, each recorded separately in the invocation ledger
  with its own prompt hash, model and usage.
- Every piece of evidence PalCert stores was attested by the provider's own
  citation data and re-verified against what PalCert sent.
- Pass B cannot hallucinate a source, because it is never given one.
