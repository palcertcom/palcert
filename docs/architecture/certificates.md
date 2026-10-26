# Compliance certificates

Phase 15. What PalCert issues when — and only when — two separate authorities
have each said yes about the same immutable thing, and what a stranger holding
a code is allowed to learn about it.

The one rule the whole phase is built around:

```
PalCert Technical Determination = COMPLIANT
              AND
Institution Decision            = APPROVED
```

Nothing else issues a certificate. There is no partial credit, no override, no
administrative exception and no route that asks for one.

## What a certificate says

Exactly this, and a reader should be able to repeat it without adding anything:

> PalCert confirms that the referenced official submission achieved a PalCert
> technical compliance determination of COMPLIANT and that the receiving
> organization recorded an APPROVED institution decision for that same
> immutable submission revision.

It is **not** a degree, not an acceptance of a paper, not a judgement of
quality, merit or originality, not an accreditation and not a licence. Both
authorities are named separately in both languages, on the artifact and on the
public page, because a single word covering both would erase the distinction
the architecture exists to preserve. In Arabic that means
`نتيجة الامتثال التقني` for PalCert's measurement and `قرار المؤسسة` for the
institution's decision — never one generic term standing in for both.

## The workflow

```
Phase 14: an immutable submission revision, handed over and decided
      ↓
the institution records APPROVED  ──┐
                                    │  same transaction
PalCert claims a certificate row ───┘  (durable intent, not a side effect)
      ↓
CERTIFICATE_ISSUE, asynchronously
      ↓
re-read the document, re-hash it        ┐
re-read the report, re-hash it          │ every one of these
recompute the Phase 14 evidence hash    │ must hold, or nothing
re-check the approval event is real     ┘ is issued at all
      ↓
build the closed, versioned claim  →  RFC 8785 canonical bytes  →  claim hash
      ↓
render the PDF  →  store claim + PDF privately  →  read both back and verify
      ↓
one transaction: ISSUED, hashes, keys, and the SYSTEM issuance event
      ↓
the holder shows somebody the number or the QR
      ↓
GET /public/certificates/:verificationCode  →  VALID | REVOKED | EXPIRED
```

Nothing in that chain re-runs a check, re-analyzes a document, calls the AI
provider, runs SmartFix or buys anything. Issuance is a statement about work
that already happened; re-deciding anything would make it a different
statement.

## Eligibility, and the cases that look close enough

| Technical determination | Institution decision | Certificate |
| --- | --- | --- |
| COMPLIANT | APPROVED | **yes** |
| NON_COMPLIANT | APPROVED | no |
| REVIEW_REQUIRED | APPROVED | no |
| INDETERMINATE | APPROVED | no |
| COMPLIANT | REJECTED | no |
| COMPLIANT | SUBMITTED / UNDER_REVIEW / REVISION_REQUESTED | no |

The first two "no" rows are the ones worth care. A university approving a
document PalCert found wanting is a perfectly ordinary Phase 14 outcome, and so
is a university rejecting one PalCert found compliant. Each produces no
certificate, and each is explained in its own terms: the first says PalCert did
not find it compliant, the second says the institution did not approve. Saying
"not eligible" to both would let somebody read a compliance failure as a
rejection by their university.

Only the submission's **current** revision can be certified, only while it is
`READY`, and only against the immutable `toStatus = APPROVED`,
`eventSource = ORGANIZATION` decision event that made it eligible. A forged
`SYSTEM` approval, an approval belonging to a different revision, or a status
with no event behind it are all the same answer: none.

## Who may write one

Nobody, except PalCert's own issuance path.

- The subject cannot create a certificate. A certificate somebody can issue
  themselves is worth nothing to a verifier.
- The approving organization cannot create one either. Approving makes a
  submission eligible; it does not hand the institution a minting key.
- A platform administrator cannot bypass eligibility. Elevation is audited and
  narrow, and it does not include "issue anyway".

Both tables are `DUAL_PARTY_SCOPED`: shared reads, no shared writes. `INSERT`
and `UPDATE` are confined to a system-writer predicate that requires a role
switch only a `SECURITY DEFINER` function owned by a privileged role can reach,
plus a transaction-local flag. The flag alone is forgeable by `palcert_app` and
buys nothing; the role switch is the real boundary. `FORCE ROW LEVEL SECURITY`
means the schema owner is bound by all of it too, which is what makes the
database tests meaningful rather than decorative.

`DELETE` is granted to nobody. A certificate is verification history.

## The claim

A closed, versioned record — `claimSchemaVersion` and
`claimCanonicalizationVersion` travel with it — canonicalized with the same RFC
8785 implementation Phase 7 uses for reports, and hashed. A golden fixture pins
the hash, so a field reordered or renamed fails a test rather than silently
changing what every future certificate hashes to.

Every label in the claim comes from the Phase 14 handoff: the organization
name, the document type name, the standard's code, name and version label as
they were when the submission was made. A university renaming itself, or an
editor revising a standard's title, must never change what an old certificate
appears to say.

The claim contains no display name, no email, no user id and no document title.
It is **document-bound, not person-bound** — see ADR-0113.

The PDF is a presentation of the claim, never its source. The claim hash is
computed from the canonical claim bytes and the artifact hash from the rendered
file; neither is an input to the other, so there is no cycle.

## The artifact

Rendered with pdfkit and locally licensed Noto fonts — no network at render
time, ever. Bilingual, with the Arabic laid out right-to-left in logical order
rather than word-reversed, which is what a naive renderer produces and what an
earlier draft of this code did produce. The QR encodes one string: the
verification URL, built from server configuration. Nothing else is smuggled
into it, and the URL appears nowhere as readable text.

The same claim renders to the same bytes, in a fresh process, on a different
day. `rendererName`, `rendererVersion` and `templateVersion` are recorded with
every certificate, so "same version, same bytes" stays checkable, and every
dependency that affects the output is pinned exactly.

The claim is also the only place the certificate's readable number and its
verification code are kept once issuance is finished — see *Where the
verification code lives* above.

Both the claim and the PDF live in the private `derived` zone under
identifier-only keys. Neither is public. The holder and the approving
organization get short-lived signed URLs pinned to the exact stored version;
public verification never serves the file.

## Where the verification code lives

This is the part worth reading twice, because the first implementation got it
wrong in a way that read as harmless.

A verification code is a **capability**: whoever holds one can verify that
certificate. So the question is not "is it encrypted" but "what does a read of
this table hand somebody".

| Place | Holds | Why that is right |
| --- | --- | --- |
| `verification_code_hash` | SHA-256 of the canonical code | One-way. The only lookup authority, and it discloses nothing. |
| `verification_code_ciphertext` | the code, AES-256-GCM, application key | Issuance staging only. The worker runs after the transaction that scheduled it, so the code must survive that gap; it is erased in the same statement that marks the certificate `ISSUED`. |
| the private claim artifact | `certificateNumber`, `verificationCode` | A private per-certificate object, and the thing the holder's copies are made from. |
| the PDF and its QR | the number and the URL | The holder's own copies, which is the entire point. |
| **the relational row** | **nothing readable** | Dropping `certificate_number` is what makes the line above true. |

`certificate_number` used to sit in that last row. It was `PC-` plus the same
32 symbols as the code, so one `SELECT` returned a working verification for
every certificate ever issued, and the digest beside it was doing no work —
storing a hash next to its own preimage is an expensive way to store the
preimage. It is dropped, not renamed. See ADR-0115.

The invariant:

```
compromise of the certificate table  ≠  disclosure of any verification capability
```

Public verification derives the displayed number from the code the caller
supplied, because a caller who can verify already holds it. Private reads take
it from the claim artifact, whose bytes are checked against the digest recorded
at issuance before anything is read out of them.

## Verification

One unauthenticated route:

```
GET /public/certificates/:verificationCode
```

- A 160-bit code, generated per certificate, Base32 over an alphabet without
  look-alikes. Only its SHA-256 digest is stored; the plaintext lives in the
  holder's PDF and in nothing the database can be made to reveal.
- Case, spacing, the `PC-` prefix and the characters a person might mistype
  are normalized before lookup.
- **No list, no search, no directory.** Not by name, not by organization, not
  by date, not by hash. Finding a certificate requires having been given one.
- Unknown, malformed, still-preparing and permanently failed codes all answer
  the same flat 404, so nothing can be probed for.
- A revoked certificate answers 200 `REVOKED` rather than 404 — an old QR
  telling its holder the truth is the entire point of online verification.
- `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, and a dedicated per-client rate limit.

The response is a separate type from the private one, not the private one with
fields stripped at the last moment — that is the pattern where a field added
later leaks by default. It carries the certificate number, the two authorities,
the organization and document-type labels, the standard, the dates, and the
digests a verifier can compare against artifacts they already hold. It carries
no identity, no title, no filename, no comment, no actor, no internal id and no
storage key, and a sentinel test asserts the absence by field name.

## Revocation

Revoking changes what verification says and nothing else. The technical result,
the institution decision, the Phase 14 history and the issued PDF are all
untouched; the artifact keeps existing and its QR now resolves to a page saying
it was withdrawn.

- A separate permission, withheld by default from reviewers and template
  managers. Recording a decision and withdrawing the thing somebody shows an
  employer are different acts.
- A closed list of administrative reason codes. PalCert cannot adjudicate why
  an institution changed its mind, and a free-text reason shown publicly would
  put PalCert's name on their judgement.
- An optional private note, recorded for the organization and never public.
- The public page shows the category only.
- There is no un-revoke, at any level of privilege.
- The subject cannot revoke their own certificate.

## Failure, and what is retried

The distinction that matters most:

| What happened | Status | Retried |
| --- | --- | --- |
| Storage, renderer or infrastructure could not finish | `PENDING`, then `FAILED_RETRYABLE` once the queue's ladder is exhausted | yes — the ladder, then reconciliation |
| The evidence does not hold up | `FAILED_PERMANENT` | **never** |

An outage says nothing about somebody's submission, so it is retried until it
works, reusing the same certificate identity and the same verification code —
a number a person may already have been shown still verifies. Evidence that
does not re-hash is fail-closed for good, because retrying it would eventually
succeed against corrupt evidence, which is the one outcome worse than issuing
nothing.

A retryable failure is handed back to the queue rather than recorded as a
finished job. Recording it as finished is what an earlier draft did, and it
made `FAILED_RETRYABLE` the one state nothing ever retried.

## Reconciliation

A read-and-enqueue sweep that finds eligible approvals with no certificate, or
with a retryable failure, and schedules them. It exists for approvals recorded
before Phase 15, for a deployment that landed mid-transaction, and for outages
that have since ended.

It is a safety net, not the mechanism. The mechanism is that scheduling happens
**inside the decision transaction**, so the invariant holds without it:

> once `APPROVED + COMPLIANT` is committed, either a certificate already exists
> or a durable `CERTIFICATE_ISSUE` intent does.

Reconciliation never edits a Phase 14 decision and never repairs a
determination. It reads, and it enqueues.

## What a certificate costs

Nothing. There is no certificate fee, no ledger movement, no hold and no
purchase. The person paid for the check, and possibly for a correction; the
certificate that follows an approval is not a product.

## Out of scope for Phase 15

Email delivery, blockchain anchoring, W3C Verifiable Credentials, X.509 or
detached digital signatures, organization-designed certificate templates,
automatic expiry policy, and any public directory of who holds what.
