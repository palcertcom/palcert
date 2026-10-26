# ADR-0086: Only operators that name a single value are corrected

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

Before SmartFix edits anything it has to know what "fixed" means. For `EQUALS
12 pt` that is obvious. For the rest of the operator vocabulary it is not.

`IN ["Arial", "Times New Roman"]` fails on a document set in Calibri. Both
members satisfy the rule. Choosing one is PalCert deciding what the author's
document should look like — a decision that is not PalCert's, and that the user
would discover only by reading their own thesis afterwards.

`MATCHES_PATTERN` is worse: satisfying it means generating text.

`GREATER_THAN 12 pt` looks numeric and tractable. It is not: the nearest
satisfying value depends on a step size nobody declared. 12.5? 13? 12.0001?
Whatever the engine picked would be an invention presented as a correction.

## Decision

**Only `EQUALS`, `>=`, `<=` and `BETWEEN` name a target SmartFix will act on.**

- `EQUALS` names the value; the inclusive bounds name a boundary reachable
  without overshooting; `BETWEEN` takes the *nearer* bound, so a document
  slightly under the minimum is not dragged to the other end of the range.
- `NOT_EQUALS`, `>`, `<`, `IN`, `NOT_IN`, `CONTAINS`, `NOT_CONTAINS` and
  `MATCHES_PATTERN` become `AMBIGUOUS_TARGET` and are shown to the user as
  manual work, with a reason code the UI translates.
- `EXISTS` and `NOT_EXISTS` become `CONTENT_CHANGE_REQUIRED`: the only remedies
  are writing content the author did not write or deleting content they did.

The classification lives in the shared registry, so both runtimes read one
answer.

## Alternatives considered

**Pick the first member of an `IN` list.** Deterministic, reproducible, and
still PalCert choosing somebody's typeface for them.

**Let the standard's author nominate a preferred member.** A reasonable future
feature, and a Phase 3 change rather than a Phase 12 one. Until the vocabulary
can express a preference, there is nothing to read.

## Consequences

- A meaningful share of real failures are reported as manual work. That is the
  honest number, and the plan says why for each one.
- The user sees the full picture before paying: what will be fixed, what will
  not, and the reason.
