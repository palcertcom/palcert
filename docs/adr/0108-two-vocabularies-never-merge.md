# ADR-0108: Preparation status and institution decision are two vocabularies

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

A submission has two independent lifecycles, and they fail in different ways.

PalCert's own work — copying the exact bytes, verifying the digests — can be in
progress, done, or broken by a storage outage. The institution's work — reading
the document and deciding about it — can be waiting, in progress, or finished
in one of three ways.

A single status enum spanning both produces a state called `FAILED` that a
person reads as "the university turned me down". It also produces the opposite
mistake: a `PENDING` that could mean "PalCert is still copying" or "nobody has
looked at it yet", with no way to tell which.

## Decision

**Two enums, two columns, and no value shared between them.**

- `SubmissionProcessingStatus`: `PREPARING`, `READY`, `FAILED`. PalCert's own
  copying. A storage-copy failure is a `FAILED` preparation and is never an
  institution rejection.
- `InstitutionDecisionStatus`: `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`,
  `REJECTED`, `REVISION_REQUESTED`. The institution's own vocabulary, fixed.
  `NOT_SUBMITTED` is a derived display state and is never stored.
- No hidden equivalents. There is no `PASSED`, no `TECHNICALLY_APPROVED`, no
  `COMPLETE`. A check constraint enumerates the five, and the state machine is
  a trigger as well as a service.
- A revision reaches `READY` and `SUBMITTED` together or not at all: the two
  are one state, and a check constraint refuses a row that has one without the
  other, the snapshot identities and the evidence hash.
- The interface carries the separation through: a catalogue test asserts that
  no processing label shares a word with a decision label, in either language.

## Alternatives considered

**One enum with a `FAILED` value.** Rejected: it is the mistake this ADR
exists to prevent, and it is not recoverable by wording alone.

**Derive the processing status from whether the snapshot columns are null.**
Rejected: it cannot distinguish "not started" from "failed and will not be
retried", which is the distinction a person needs.

## Consequences

Every surface carries two statuses, and the UI has to decide which is primary.
It shows the institution's decision as the headline and PalCert's processing
state as the explanation beneath, because the second only matters while the
first has not happened.
