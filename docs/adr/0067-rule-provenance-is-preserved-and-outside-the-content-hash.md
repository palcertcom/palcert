# ADR-0067: Accepted-rule provenance is preserved, and deliberately outside the standard's content hash

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 9

## Context

A rule accepted from an extraction has a history worth keeping: which run
produced it, which proposal it came from, which source document, that source's
digest, and the page or paragraph the requirement was quoted from. An
institution asked "why does our standard say 30 mm?" should be able to answer
with the passage rather than with a shrug.

That history raises a question about ADR-0023, which defines a standard
version's `contentHash` as a canonical digest of its semantic rule content, and
ADR-0024, which makes a published version immutable. If provenance entered the
hash, two problems follow. Two institutions with identical requirements would
get different hashes because one wrote its rules by hand. And the hash would
change when nothing about what the standard *requires* had changed.

## Decision

Provenance is recorded in `StandardRuleProvenance`, a separate table bound to
the accepted rule, the proposal, the run and the source asset, carrying the
source's `sha256` and the exact locator.

**Provenance is metadata, not content.** It is excluded from the canonical
representation the `contentHash` covers. A standard's hash answers "what does
this standard require?"; how a rule came to be written is a different question
with a different answer.

Correspondingly, an unaccepted proposal never affects `StandardVersion.contentHash`
at all. A draft with fifty pending proposals and a draft with none hash
identically if their rules are the same, and an e2e test asserts it.

`RuleOrigin` keeps its Phase 3 meaning: the normative source of the requirement
— institutional policy, a journal's instructions, a national regulation. It is
**not** repurposed to mean "a model generated this". The reviewer may correct
what the model guessed, because AI is the extraction mechanism and never the
authority.

Where a reviewer changed a proposal before accepting it, both are kept: the
proposal exactly as the model produced it, and the rule as the human accepted
it, on the decision record. The AI history is never rewritten to look as though
the model proposed what the human chose.

A source cited by an accepted rule is retention-locked and cannot be deleted,
because deleting it would leave a published standard citing evidence that no
longer exists.

## Alternatives considered

**Include provenance in the content hash.** Rejected, as above.

**Add an `AI_EXTRACTED` value to `RuleOrigin`.** Rejected: it conflates "where
the requirement comes from" with "how it was typed in", and it would make every
extracted rule look less authoritative than an identical hand-written one.

**Discard the model's version once a human edits it.** Rejected: the difference
between what was proposed and what was accepted is exactly what a later audit
wants to see.

## Consequences

- A rule's provenance can be shown without any risk of altering the standard's
  identity.
- Verification and certification (Phases 11+) continue to compare content
  hashes that mean the same thing whether a standard was extracted or typed.
- Deleting a source is refused when a rule depends on it, with a message that
  explains why rather than a bare 409.
