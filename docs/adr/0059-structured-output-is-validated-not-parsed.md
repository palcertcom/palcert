# ADR-0059: Model output is schema-constrained and validated, never parsed out of prose

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

A model asked for JSON in an instruction will usually return JSON, and
occasionally return "Here is the JSON:" followed by a fenced block, and
occasionally return a fourth rule nobody asked about, and occasionally cite a
paragraph that does not exist. Every one of those is a correctness problem for
a system that stores the result next to a student's compliance report.

## Decision

PalCert asks for structured output through the provider's own mechanism
(`output_config.format` with a JSON schema). It does not:

- parse JSON out of free-form text or depend on Markdown fences;
- use assistant prefill to coax a shape;
- blindly set `temperature`, `top_p` or `top_k`;
- declare any tools. Phase 8 calls have **no** external tools at all.

Every response is then validated before anything is persisted, against the
published `ai-assessment.schema.json` and against the request:

- **Exactly the requested rule codes.** If `{A, B, C}` were asked for, the
  response must contain `{A, B, C}` — a missing rule, a duplicate rule, or an
  invented `RULE_D` is an invalid response, not a partial success.
- **Only supplied evidence.** Every cited node id must be one PalCert put in
  the bundle. An unknown node id means the output is invalid; fabricated
  evidence is never stored.
- **A non-`INSUFFICIENT_EVIDENCE` verdict must cite something.**

Rejections carry no model text, so an invalid response cannot smuggle content
into a log or an error body.

The schema deliberately offers no confidence number. A model asked for
`confidence: 0.93` will produce one, and it will mean nothing. It offers a
closed set of reason codes and uncertainty reasons instead — and
`INSUFFICIENT_EVIDENCE` is explicitly described to the model as a correct and
expected answer, because a refusal to guess is the behaviour PalCert wants.

## Alternatives considered

**Repair malformed output.** Rejected: a repaired response is a response
PalCert invented, and the point of validation is to know what the model
actually said.

**Accept extra rules and ignore them.** Rejected: an assessment of a rule
nobody asked about signals a prompt or context defect worth failing on.

## Consequences

- A structurally invalid response fails the review cleanly instead of storing
  something plausible and wrong.
- Evidence citations are always resolvable back to a node PalCert supplied.
- The failure is visible in `failureKind` (`OUTPUT_INVALID`,
  `PROVIDER_REFUSAL`, …) without recording what the model said.
