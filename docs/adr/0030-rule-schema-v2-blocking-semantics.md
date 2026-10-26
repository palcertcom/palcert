# ADR-0030: Rule Schema v2 — blocking in any evaluation mode, versioned not retroactive

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 4

## Context

Phase 3 required a `blocking` rule to be `DETERMINISTIC`
([standards.md](../architecture/standards.md), "Safety invariants"). The
reasoning was sound as far as it went: a blocking rule stops certification, and
only a reproducible measurement should be able to do that.

It was too restrictive for the real product. A scientific journal may
legitimately refuse to certify a manuscript without an ethics declaration, a
conflict-of-interest statement, a data-availability statement, or blind-review
anonymization. None of those can be measured; each is judged by a model or a
person. Under the v1 invariant a journal could not express its own hard
requirements.

The invariant was also encoded in three places — the validator, a database
check constraint and the rule builder — and in published content whose hashes
must never change.

## Decision

**The safety property moves from authoring to evaluation.**

> A rule may be blocking regardless of evaluation mode, but an unresolved
> non-deterministic blocking rule prevents a final compliance decision until it
> has been appropriately resolved.

This is **Rule Schema version 2**. Version 1 remains valid and keeps its own
semantics:

- `RULE_SCHEMA_VERSION` becomes `2`; `SUPPORTED_RULE_SCHEMA_VERSIONS` is
  `[1, 2]`. New drafts are written under v2.
- `validateRuleDefinition` is **version-aware**. Under v1 it still refuses a
  blocking non-deterministic rule; under v2 it accepts one. The API judges each
  rule by the schema version of the version that owns it, so a v1 draft edited
  today is still a v1 draft.
- The database constraint is replaced by a version-aware form
  (`rule_schema_version >= 2 OR blocking = false OR evaluation_mode =
  'DETERMINISTIC'`). Every existing row already satisfies it, so the migration
  cannot fail on historical data. A trigger requires a rule's version to match
  its parent's, so a draft is never a mixture.
- **Nothing published is rewritten.** Existing rows keep `rule_schema_version
  = 1`. Canonicalization is untouched, `STANDARD_CANONICALIZATION_VERSION` stays
  `1`, and the Phase 3 golden hash is pinned to a literal v1 fixture so it is
  proven unchanged.
- **Upgrading is explicit.** Cloning a version preserves its schema version.
  `POST …/clone` accepts `upgradeRuleSchema: true`, which writes the *new
  draft* under the current version and records both versions in the audit
  event. The source is never modified on either path; a "downgrade" is refused.
- **The engine enforces the moved property.** Phase 4 evaluates deterministic
  rules only. Every `AI_ASSISTED` and `MANUAL` rule returns `INDETERMINATE` with
  `requiresReview: true`, and a blocking one therefore holds the compliance
  decision open ([ADR-0028](0028-evaluation-result-semantics.md)). Phase 7 must
  refuse to finalise while such a result is outstanding; Phase 8's AI output
  can inform a reviewer but never resolve the rule by itself.
- **The rule builder** no longer disables `blocking` for unmeasured rules on a
  v2 draft. It explains the consequence instead: certification stays open until
  a reviewer resolves the rule. On a v1 draft it keeps the old behaviour and
  says why, in both locales.

## Alternatives considered

**Keep the v1 invariant and model the journal's needs as non-blocking
`CRITICAL` rules.** Rejected: "critical but not blocking" is a contradiction
the product would have to explain to every journal editor, and it makes the
compliance decision depend on severity heuristics instead of the standard's
own statement of what blocks.

**Amend v1 in place.** Rejected. It would change the meaning of published
content without changing its hash, which is exactly the property
[ADR-0023](0023-standard-content-hashing.md) and
[ADR-0024](0024-published-immutability.md) exist to make impossible.

**Auto-upgrade on clone.** Rejected. A clone is a faithful copy; quietly
re-stamping copied content with a version its author never chose misrepresents
what they wrote, and an author who did not know their draft had been upgraded
could not know why the builder's controls had changed.

## Consequences

- A journal can state its real requirements. The certificate is still only
  ever issued on deterministic evidence
  ([ADR-0002](0002-hybrid-deterministic-and-ai-compliance.md)) *plus* explicit
  human resolution of every unresolved blocking rule.
- Two schema versions are live indefinitely. Every consumer of a rule — the
  validator, the builder, the engine, the database — is version-aware, and the
  rule-schema descriptor advertises the supported list so clients do not have
  to hard-code it.
- The v1 hash regression test is the guard. Any future change to
  canonicalization must bump `STANDARD_CANONICALIZATION_VERSION` and will fail
  that test until it does.
- The next such amendment follows the same pattern: a new version, v1 and v2
  unchanged, an explicit upgrade path, and the migration provably satisfied by
  every existing row.
