# ADR-0025: One optimistic-concurrency strategy, via If-Match

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 3

## Context

Two people can edit the same draft standard at once. Without a concurrency
control the later write silently discards the earlier one — and in a document
that other people must comply with, a silently dropped rule is a serious defect.

## Decision

**One strategy, everywhere: HTTP `If-Match` carrying the version's `revision`.**

- Every version read returns `ETag: "<revision>"`.
- Every mutating request against a draft — including mutations of its *rules* —
  must carry `If-Match`. A missing header is `VALIDATION_FAILED` (400); a stale
  one is `STANDARD_VERSION_CONFLICT` (412), reporting the current revision so the
  client can re-read and retry.
- Every accepted mutation increments the version's `revision`, and the mutation
  takes `SELECT … FOR UPDATE` on the version row *before* comparing, so two
  requests holding the same revision cannot both pass.

**The version is the unit of concurrency, not the rule.** A rule has no
independent lifecycle: it exists only inside one version, is published with it,
and is frozen with it. Two authors editing different rules of the same draft
*are* in conflict, because publication takes the whole set.

**Publish is the deliberate exception** and requires no `If-Match`. The row lock
is what makes it safe, and a repeat publish returns the existing state rather
than failing — so a client retrying after a dropped response is not told it
broke something. Demanding a revision there would make that retry fail
spuriously.

## Consequences

- 412 rather than a bare 409 on a stale precondition: 412 is precisely "your
  precondition did not hold", and it tells a client to retry with a fresh
  revision rather than to stop.
- A missing header is rejected rather than treated as consent. Treating it as
  consent would make the protection opt-in, and every client that forgot it
  would silently get last-write-wins — the exact failure being prevented.
- `*` is rejected: it means "any current representation", which for an edit is
  indistinguishable from no precondition at all.
- There is deliberately no second mechanism (no `updatedAt` comparison, no
  last-write-wins path). Two strategies in one aggregate is how a system ends up
  with a route that quietly overwrites.

## Alternatives considered

**A body field (`expectedRevision`).** Workable, but it puts a transport concern
in the payload and makes every DTO carry it. `If-Match` is the HTTP-native
expression of exactly this.

**Per-rule revisions.** Rejected: it would let two authors both succeed while
producing a rule set neither intended, because publication takes the set.
