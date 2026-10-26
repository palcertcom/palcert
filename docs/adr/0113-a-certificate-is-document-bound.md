# ADR-0113: A certificate is document-bound, not person-bound

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 15

## Context

A public verification page is the only unauthenticated surface in PalCert that
answers about somebody's work. Whatever it says is, in effect, published: a
verifier can screenshot it, a crawler can find it if a holder posts the link,
and it cannot be taken back.

The obvious design is to put the holder's name on it. Every paper certificate
does. It is also what makes a certificate a privacy problem: a name plus an
institution plus a document type plus a date is an identifiable record about a
student, published at a URL, for ever.

## Decision

**The public claim names the document and the two authorities. It never names
the person.**

- No display name, no email, no user id, no student number, and no submission,
  revision, check or report id.
- No document title and no filename. "Master's thesis" is a document type;
  "Ali's thesis on X" is not something a stranger needs.
- Internal ownership fields exist on the row, so the two parties can find their
  own records. They are not in the public type and not in the public
  projection.
- The public response is a **separate type** from the private one, not the
  private one with fields removed at serialization time. That is the pattern
  where a field added a year later leaks by default.
- The public database projection is a narrow `SECURITY DEFINER` function with a
  fixed column list, a pinned `search_path`, no dynamic SQL and no mutation —
  asserted by raw-SQL tests rather than by reading it.
- A leak-guard test asserts the serialized response contains nothing matching a
  list of identity-shaped field names, so a future `ownerUserId` fails a test
  rather than reaching the internet.

Binding is therefore to the document and its evidence: the document digest, the
report hash, the standard content hash, the submission evidence hash, the claim
hash and the artifact digest. A verifier who holds the document can prove it is
the one that was certified. A verifier who does not cannot learn who wrote it.

## Alternatives considered

**Name the holder publicly.** Makes the page an identifiable record about a
student that cannot be retracted, in exchange for convenience PalCert can
provide another way.

**Name the holder only to authenticated verifiers.** Requires a verifier
account, which turns a QR code into a sign-up funnel and still stores the
association.

**Let the organization choose.** Makes the privacy properties of a PalCert
certificate vary by university, which is not a property a certificate can have.

## Consequences

- A verifier who needs to know *whose* document it is asks the holder, who can
  show them the document the digest matches. The certificate proves the
  binding; the holder proves the identity.
- Adding identity later is a new claim version and a new public type, both
  deliberate acts, rather than a field someone adds to an interface.
- Nothing about the holder changes what the certificate says: account edits,
  renames and email changes leave the immutable claim alone.
