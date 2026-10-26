# ADR-0088: The change manifest is computed from the output, never from the plan

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

A change manifest is the document PalCert hands a user to answer "what did you
change in my thesis?". The cheapest way to produce one is to render the plan:
the actions are already there, each with a before and an after.

That manifest describes an *intention*. It is identical whether the edit landed
on the right element, the wrong element, or no element at all. The failure mode
it cannot see is precisely the one that matters: an action that succeeded
mechanically and changed nothing — the wrong script channel, a style that still
wins, an attribute Word ignores.

## Decision

**The manifest is built by re-reading the corrected document.**

- After writing, the engine re-opens the output, rebuilds the Phase 6 model,
  and re-reads the effective value of every action's target.
- A target that does not now hold the action's `after` value fails the whole
  correction with `SMARTFIX_CHANGE_NOT_APPLIED`. Nothing is delivered and
  nothing is charged.
- Four integrity projections — visible text, media, field instructions,
  relationships — are computed identically before and after and must match.
- Those eight digests are stored as *columns*, and a CHECK constraint refuses a
  manifest whose before and after disagree. An invariant that lives only inside
  a JSON blob is an invariant nothing can enforce.

## Alternatives considered

**Render the plan and trust the engine.** Then the manifest is a restatement of
the request, and the one thing it exists to catch is invisible to it.

**Verify with the recheck instead.** The recheck answers a different question —
"does the document pass?" — and cannot distinguish "the edit did nothing" from
"the edit worked and another rule fails".

## Consequences

- Every correction reads and analyzes the document twice. That cost buys the
  only evidence that makes delivery defensible.
- The manifest carries no document text: a formatting change is described by
  where it happened and what the value was, and storing the sentence would be
  storing the thesis.
