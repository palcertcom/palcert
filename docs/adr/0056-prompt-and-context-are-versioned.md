# ADR-0056: Prompts and context builders are versioned, and every invocation records which was used

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

Two AI reviews of the same document can legitimately disagree — a different
model, a reworded prompt, a changed selection of paragraphs. Without a record
of *which* prompt and *which* context builder produced a given assessment, an
old review becomes uninterpretable the moment either changes, and "why did it
say that?" has no answer.

## Decision

Prompts live in a single registry as fixed strings with an id, a version and a
SHA-256 hash. They are never assembled in a controller or a job handler, and
they contain no interpolation at all — a template is a constant, which is the
structural reason document text cannot reach the system prompt.

Every `AIReview` and every `AIInvocation` records:

- `provider`, `configuredModel`, `providerReturnedModel`
- `promptVersion`, `promptHash`
- `contextBuilderVersion`, `contextHash`, `rulesHash`
- `aiReviewSchemaVersion`

`promptHash` covers the template **only**. Document content is deliberately
excluded: a hash that changed with every document would identify nothing, and
would make the prompt registry's identity depend on private data.

The exact model name is configuration (`AI_MODEL`), never application identity.
Both the name PalCert asked for and the name the provider reported are stored,
because they can differ.

## Alternatives considered

**Store the full prompt and response.** Rejected by default: it would persist
document excerpts and model prose in a second place, multiplying the privacy
surface for a debugging convenience. The hashes prove which normalized inputs
were used without storing them.

**Version only the prompt.** Rejected: a change to which paragraphs get
selected changes the answer just as much as a change to the wording.

## Consequences

- An old review stays interpretable after the prompt changes.
- A new prompt or model produces a **new** review; it never overwrites an
  existing completed one.
- Reproducibility is auditable, but "same input → same output" is never claimed
  as a system invariant: model providers do not guarantee it, and PalCert will
  not promise on their behalf.
