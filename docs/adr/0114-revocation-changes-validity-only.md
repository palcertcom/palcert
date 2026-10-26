# ADR-0114: Revocation changes validity and nothing else

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 15

## Context

Institutions will occasionally need to withdraw a certificate: it was recorded
against the wrong intake, a security incident touched the issuing path, an
administrative correction is needed. Whatever the reason, somebody is already
holding a PDF, and quite possibly has already shown it to an employer.

Two tempting designs are both wrong. Deleting the certificate makes the PDF
they hold unfalsifiable — it verifies as "no such certificate", which reads as
a forgery rather than as a withdrawal. Rewriting the claim makes the artifact
they hold disagree with the record, which is worse.

## Decision

**Revocation is an append-only event that changes what verification says.**

- The claim, the claim hash, the technical result, the institution decision,
  the Phase 14 history and the issued PDF are all untouched.
- The artifact stays downloadable by both parties. It is the record of what was
  issued; hiding it would not unsay it.
- Public verification answers `200 REVOKED`, not `404`. An old QR telling its
  holder the truth is the entire point of online verification.
- Revoking is a **separate permission**, withheld by default from
  `ORGANIZATION_REVIEWER` and `ORGANIZATION_TEMPLATE_MANAGER`. Recording a
  decision and withdrawing the thing somebody shows an employer are different
  acts.
- The subject cannot revoke their own certificate.
- A platform administrator can, only through audited elevation, and even then
  cannot issue one.
- The reason is a **closed list of administrative categories**. PalCert cannot
  adjudicate why an institution changed its mind, and free text shown publicly
  would put PalCert's name on their judgement. An optional note is recorded for
  the organization and is never public; the public page shows the category
  alone.
- There is **no un-revoke**, at any level of privilege. A mistaken revocation
  is corrected by a new submission and a new approval, which is the honest
  record of what happened.

## Alternatives considered

**Hard-delete.** Makes a holder's PDF read as a forgery and destroys the
verification history a dispute would need.

**Re-issue on revoke.** Two certificates for one revision, and a verifier with
the old number cannot tell which is authoritative.

**Free-text public reason.** Publishes an institution's private reasoning under
PalCert's name, and invites reasons that are really judgements about a person.

## Consequences

- `REVOKED` is a terminal issuance status with its own public vocabulary, and
  the transition guard refuses every way back.
- The one-issuance-event-per-certificate index stays intact: revocation adds an
  event, it does not replace one.
- An organization that suspends or leaves does not automatically revoke
  anything. Withdrawal is a decision somebody makes, not a side effect.
