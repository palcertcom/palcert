# ADR-0115: The certificate row holds no verification capability

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 15

## Context

The first Phase 15 schema stored `verification_code_hash` — correctly, as the
only lookup authority — and, beside it, `certificate_number`.

The number was `PC-` plus the same 32 Crockford symbols as the verification
code, hyphenated for readability. Stripping a prefix and four hyphens is not a
transformation. So the column was a plaintext capability, and one `SELECT` over
`compliance_certificates` returned a working public verification for every
certificate the platform had ever issued.

The hash was doing no work at all. Storing a digest next to its own preimage is
a rather expensive way of storing the preimage.

This was not caught by the leak-guard tests, because every one of them asked
"does the *public response* contain something identity-shaped". None asked
"what does the table hand somebody who has read access to it". A field named
`certificateNumber` reads as a label, not as a secret, which is exactly why it
survived review.

## Decision

**The relational row stores the one-way digest, and — only while issuance still
needs it — the code sealed under a key PostgreSQL does not hold.**

- `verification_code_hash` stays, unique, the only lookup authority.
- `certificate_number` is **dropped**, not renamed. A column still holding
  `PC-…` under a different name would be the same disclosure with a better
  cover story.
- `verification_code_ciphertext` is issuance staging material: AES-256-GCM via
  PalCert's existing secret box, under `CERTIFICATE_VERIFICATION_SECRET_KEY`,
  held by the application. A certificate is claimed in the transaction that
  records the approval and rendered by a worker later, so the code has to
  survive that gap somewhere; sealed in the row is the one place it can do so
  without also surviving in Redis, in a job payload, or in the clear.
- `app_certificate_issue` erases the ciphertext **in the same statement** that
  marks the certificate `ISSUED`, so there is no window in which an issued
  certificate still carries an openable copy. `app_certificate_fail` erases it
  on a permanent failure and keeps it on a retryable one, because the retry
  must produce the same code.
- The readable number lives where the holder's copies live: the private
  immutable claim artifact, the PDF, and the QR.
- **Public verification** derives the displayed number from the code the caller
  supplied. A caller who can verify already holds the code, so the database has
  no reason to keep its readable form. The projection no longer returns one.
- **Private reads** take the number and the code from the claim artifact, whose
  bytes are checked against the digest recorded at issuance and whose own claim
  hash is recomputed, before anything is read out of it.

The invariant:

```
compromise of the certificate table
    ≠
disclosure of any public verification capability
```

## Alternatives considered

**A separate display number, unrelated to the code.** Two identifiers for one
certificate: one printed, one verifying. A holder reading the number off their
PDF and typing it in would fail, so the PDF would have to show both, and the
first support question would be which one to send. It also buys nothing the
digest does not already give.

**Encrypt the number in place and decrypt on read.** The same capability with a
key in front of it, kept for ever rather than for minutes — and every private
read would decrypt it, so the plaintext would be in process memory constantly.
Erasing it at issuance is strictly better.

**Keep the plaintext and rely on database access control.** Row-level security
already confines *who sees which row*; it cannot make a row that is read
legitimately stop being a capability. And `palcert_app`, a backup, or a support
query would each be a full disclosure.

**Keep the ciphertext after issuance, for support.** Considered and rejected:
nothing in the product needs to recover a code after the holder has one, and
the only thing keeping it would buy is a second copy to lose. It is erased.

## Consequences

- A private certificate read now costs one storage round trip to fetch and
  verify the claim. That is the price of not keeping the column, and it comes
  with a free integrity check on every read.
- An unissued certificate has no number and no code to show, and the view says
  so with nulls. That is correct: nothing has been issued to name.
- A key rotation before issuance makes an unissued certificate's code
  unrecoverable. The claim function re-keys such a row — new code, new digest,
  new sealed copy — which is safe precisely because nothing was ever issued
  from it. An issued certificate's digest is immutable, enforced by the guard
  trigger, so an already-printed QR never stops resolving.
- The database tests now assert the boundary by sentinel: take the real code
  out of the issued claim and search every visible column of every certificate
  row for it, in every form it could plausibly be stored in.
