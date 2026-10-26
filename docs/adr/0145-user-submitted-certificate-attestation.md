# ADR-0145: Institutions attest the exact bytes a user submits; PalCert records and settles

- **Status:** Accepted
- **Date:** 2026-09-30
- **Phase:** Post-RC attestation
- **Related:** [ADR-0144](0144-portable-standard-packages.md), [certificates](../architecture/certificates.md), [finance](../architecture/finance.md), [attestations](../architecture/attestations.md)

## Context

Users hold certificates PalCert never issued — degrees, transcripts, training
certificates — and want a third party to be able to check them. Institutions on
PalCert are willing to confirm certificates they issued, for a fee. PalCert
already has most of the parts: a hardened upload pipeline, dual-party
row-level security, a customer credit ledger with holds, notifications and a
public verification surface for its own compliance certificates.

What it did not have: a way for an organization to *earn* money (the ledger is
customer-only), a price that can differ per institution, a commission, and a
public claim that is about a file rather than about a document PalCert
measured.

## Decision

1. **The claim is narrow.** An attestation says that a named institution
   confirmed a specific file — identified by its SHA-256 — with specific
   details, over a validity period. Every page carries: *"PalCert attests a
   submitted artifact. It does not imply PalCert originally issued that external
   certificate."* PalCert renders no certificate of its own and never publishes
   the file.
2. **Exact bytes.** The digest is measured by PalCert on ingest and re-measured
   from storage at approval; a mismatch refuses approval. The database refuses
   an attestation whose artifact fields differ from the request's current
   READY artifact.
3. **Two state machines.** Request workflow (`DRAFT` → … → `APPROVED` /
   `REJECTED` / `CANCELLED`) and attestation verification (`VALID` /
   `EXPIRED` / `REVOKED`, computed) are separate enums. Revocation never
   deletes; the public page answers `REVOKED`.
4. **Immutable records.** Attestations are immutable except for one
   revocation; request price snapshots are immutable; history, settlements,
   revenue entries, reminders and commission rows are append-only; attestation
   rows refuse `DELETE` even from a privileged connection.
5. **One balance.** The fee is reserved from the user's existing CASH balance
   with the existing credit-hold machinery on submit, captured on approval,
   released on rejection or cancellation. No second wallet.
6. **Revenue is a separate, balanced record.** Approval writes one settlement
   and exactly two revenue entries (institution, PalCert commission) whose sum
   a deferred constraint trigger checks. The customer ledger stays
   customer-only.
7. **Per-institution commission**, append-only with effective time, author and
   reason; the rate at submission is snapshotted with the fee.
8. **Money moves in a worker.** A reviewer's session cannot touch another
   user's ledger under RLS, so the decision enqueues an `ATTESTATION_PAYMENT`
   job in its own transaction and the job settles under platform-admin
   context, idempotently.
9. **Unguessable public tokens** stored as a hash plus a sealed copy under a key
   derived from the existing certificate verification secret; no new secret.
10. **No AI.** Uploaded certificates are never sent to an AI service.

## Alternatives considered

- *Reuse the compliance-certificate tables.* Rejected: a compliance certificate
  asserts PalCert's own measurement against a standard; mixing the two claims
  would let one be read as the other.
- *Organization ledger accounts.* Rejected for now: the ledger's invariants are
  built around customer balances. A separate settlement/revenue record keeps
  the institution's earnings auditable without changing them. Payouts are out
  of scope.
- *Settle in the reviewer's request.* Rejected: it needs a reviewer to hold
  write access to another user's ledger rows.
- *Publish the file on the verification page.* Rejected: the verifier needs
  the digest, not the file; the holder decides who gets the file.

## Consequences

- Nine new tables, three additive migrations, no change to existing rows.
- Approved fees are not refunded automatically (including on revocation);
  staff can still adjust manually.
- Backups and restores cover attestation objects.
- Institutions cannot see drafts, other institutions' requests, or whether
  another institution has seen the same file.
