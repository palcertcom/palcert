# ADR-0104: A private check is never an official submission

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

Phases 7 through 13 built a private capability: a person uploads their own
document, buys a check against a published standard, reads a technical report,
optionally corrects the document and rechecks it. Everything in that sequence
is theirs. The organization that published the standard is not a party to any
of it and, by ADR-0031, cannot see any of it.

Phase 14 adds the other half of the product: handing a checked document to the
institution that will decide about it. The temptation — and the shape a
less careful system would take — is to treat the check itself as the
submission. The organization owns the standard, the check was measured against
that standard, so let the organization see the checks measured against it.

That would be a different product. It would mean that buying a check against a
university's standard tells the university you are applying, that a failed
practice run is visible to the people who will judge the real one, and that a
person cannot privately find out whether their thesis is ready.

## Decision

**Submission is a separate, explicit act, and the only thing that creates an
official record.**

- A Check is private for ever unless its author submits it.
- Nothing submits on the author's behalf: not a check completing, not a
  SmartFix delivering, not a payment settling, not an AI review returning.
- The author is shown, before they act, exactly what would be shared and
  exactly what would not.
- Owning the standard grants the organization no access to the document, the
  Check, the report, the analysis, the AI review, the SmartFix internals, the
  balance, or any other version of the document.
- No organization membership is required to submit. An independent researcher
  submitting to a university they have never belonged to is the ordinary case.

## Alternatives considered

**Make checks against a standard visible to its owner.** Rejected: it makes
every private rehearsal public to the examiner and destroys the reason the
private check exists.

**Ask for consent once, then submit automatically on every later check.**
Rejected: a consent given in March cannot authorize a handoff in September of
a document that has changed since. The authorization must name the exact bytes.

**Let the author choose which organization receives a submission.** Rejected:
the recipient is whoever owns the standard the check was measured against.
Choosing separately would allow a document checked against one university's
rules to be submitted to another as if it had been measured against theirs.

## Consequences

The organization's entire view of a person is one submission and its snapshot.
Every feature that would widen it — a "students who checked against us" list, a
"see their other attempts" link — has to be argued against this ADR first.

A person can use PalCert without any institution ever knowing, which is the
promise the private check makes and the reason they will trust the submission.
