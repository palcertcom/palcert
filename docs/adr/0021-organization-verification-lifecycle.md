# ADR-0021: Organization verification as an attempt history

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 2

## Context

PalCert needs to know that an organization is who it says it is before its
certificates mean anything. But Phase 2 must not become a KYC platform, and
verification must be extensible to evidence upload later without being replaced.

## Decision

**Two fields on the organization, one row per attempt.**

`organizations.verification_status` is the current state
(`UNVERIFIED`/`PENDING`/`VERIFIED`/`REJECTED`) — the thing every read needs.
Each request is a row in `organization_verification_requests`, so a rejection
followed by a resubmission produces a history rather than overwriting the
earlier decision. That history is what an evidence table will later hang off.

```
UNVERIFIED ──request──► PENDING ──approve──► VERIFIED
     ▲                     │
     │                  reject
     │                     ▼
     └────resubmit──── REJECTED
```

- **Rejection is not deletion.** The organization stays `ACTIVE` and fully
  operational; only its verification claim is withheld. Deleting or suspending
  on rejection would conflate identity checking with enforcement.
- **`VERIFIED` is terminal** for now. Un-verifying needs an explicit revocation
  flow with its own audit semantics, which Phase 2 does not provide, so the
  state machine refuses rather than allowing an undocumented transition.
- **A partial unique index** allows at most one `PENDING` request per
  organization, expressing "only while pending" in a way a plain constraint
  cannot.
- **Two reason fields, deliberately.** `decision_reason` is applicant-facing and
  returned to the organization. `internal_notes` is reviewer-only and is read by
  no organization-facing code path — asserted by test, because "we remembered
  not to select it" is not a control.

### What verification means

Exported once, as `VERIFICATION_SEMANTICS`, so the API and both UI locales say
the same thing:

> PalCert verification confirms that the organization's identity and account
> have passed PalCert's verification process. It is not an assessment of
> academic quality, research validity or editorial standards.

The badge carries it as a tooltip. PalCert must never appear to be endorsing
scholarship it has not evaluated (§27, §24).

### Review surface

API-only for Phase 2: `GET /admin/organizations/verification-queue` and
`POST /admin/organizations/:id/verification`. Both require
`admin:organization:verify` **and** a recently authenticated session. The full
admin portal is Phase 19; building a throwaway UI now would be waste.

## Consequences

- One extra table, and a join for "why was I rejected".
- Evidence upload becomes a child table of the request — additive.
- Approving requires a pending request to exist, so an approval always
  corresponds to something a human submitted.
