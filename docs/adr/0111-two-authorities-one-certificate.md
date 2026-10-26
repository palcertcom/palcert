# ADR-0111: A certificate requires both authorities, with no partial credit

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 15

## Context

Phase 14 established that PalCert's technical determination and an
institution's decision are two separate things, recorded separately and never
merged. Phase 15 has to issue something on top of both without quietly
collapsing them back together.

Two outcomes make the pressure concrete, and both are ordinary rather than
exceptional:

- A university approves a submission PalCert measured `NON_COMPLIANT`. That is
  their prerogative; formatting is not the only thing a thesis is judged on.
- A university rejects a submission PalCert measured `COMPLIANT`. Also their
  prerogative; a deadline passed, a supervisor changed their mind.

A certificate issued for either would say something neither authority said.

## Decision

**The conjunction, and only the conjunction.**

```
technical determination = COMPLIANT  AND  institution decision = APPROVED
```

- Evaluated by a database function, not by the service. The service predicate
  exists to *explain* an answer to a person, not to decide one, and if the two
  ever disagree the database wins and nothing is issued.
- The status is not enough: there must be the matching immutable
  `toStatus = APPROVED`, `eventSource = ORGANIZATION` decision event on that
  exact revision. A forged `SYSTEM` approval or one belonging to a different
  revision is refused.
- Only the submission's current revision, and only while `READY`.
- `REVIEW_REQUIRED` and `INDETERMINATE` are not near-misses; they are not
  `COMPLIANT`, and PalCert will not decide what the engine could not.
- Ineligibility is explained by *which half* is unmet, never as a shared "not
  eligible". Somebody whose compliant work was rejected and somebody whose
  approved work was not compliant must each be told what actually happened.

## Alternatives considered

**A certificate for any approval, with the determination printed on it.** The
sentence a verifier repeats is "the university approved it and PalCert says
here is a certificate". The nuance printed underneath does not survive being
retold.

**A lesser certificate for the near-miss cases.** Every lesser certificate
eventually gets shown as a certificate. A verifier cannot be expected to know
PalCert's internal tiers.

**A per-organization policy for what certifies.** This would make "PalCert
certificate" mean a different thing at each university, which is the one
property a certificate cannot have.

## Consequences

- The `NON_COMPLIANT + APPROVED` and `COMPLIANT + REJECTED` cases are tested
  explicitly and permanently, in both directions.
- An institution that wants to recognise a non-compliant submission can still
  approve it. PalCert simply does not certify it, and says why in terms that do
  not blame them.
- Adding a third authority later means a new claim version, not a new meaning
  for the existing one.
