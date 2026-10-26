# ADR-0112: Issuance is scheduled inside the decision transaction

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 15

## Context

Issuing a certificate re-reads two stored objects, recomputes three hashes,
renders a PDF and writes two artifacts. None of that belongs in the HTTP
request a reviewer makes when they press Approve — they would wait on storage
for something that is not their concern.

So issuance is asynchronous. The question is what guarantees it happens.

The obvious shape is: commit the decision, then enqueue. It looks equivalent to
doing both together and is not. A crash between the two leaves an approved,
compliant submission that nothing will ever certify, and the person waiting for
it cannot tell that from slow.

A reconciliation sweep would eventually find it. But a sweep that is the *only*
thing standing between an approval and a certificate is a sweep whose interval
is the product's real latency, and whose failure is silent.

## Decision

**Claim the certificate row and enqueue the job in the same transaction that
records the decision.**

The invariant:

> once `APPROVED + COMPLIANT` is committed, either a certificate already exists
> or a durable `CERTIFICATE_ISSUE` intent does.

- The reviewer still does not wait: no claim is built, no PDF rendered and no
  storage touched in that transaction. Only a row and a job, both cheap, both
  in a transaction that was already open.
- The claim goes through the same narrow system function everything else does.
  The organization is **not** given generic `INSERT` authority on the
  certificate table to make this work — that would trade the whole write model
  for a scheduling convenience.
- The job's identity is the certificate, so ten deliveries converge on one
  piece of work.
- Reconciliation remains, as a safety net for approvals recorded before Phase
  15 existed, for a deployment that landed mid-flight, and for outages that
  have since ended. It reads and enqueues; it never edits a Phase 14 decision
  and never repairs a determination.

## Alternatives considered

**Enqueue after commit.** The failure window above, with no way for the waiting
person to distinguish it from latency.

**Reconciliation only.** Makes the sweep interval the product's latency and its
failure silent.

**Issue synchronously in the request.** Makes a reviewer's Approve depend on
storage and on a PDF renderer, and turns a slow object store into a decision
that appears not to have been recorded.

## Consequences

- The decision transaction now touches a Phase 15 table. It does so through the
  system function, so the write authority story is unchanged.
- An ineligible decision costs one cheap predicate and no round trip.
- The reconciliation sweep is testable as what it is — recovery — rather than
  as the mechanism.
