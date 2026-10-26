# ADR-0058: External AI processing happens only after the person agrees

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

A PalCert user uploads unpublished academic work. Sending parts of it to a
third-party model API is a materially different act from checking margins on
PalCert's own servers, and a person can reasonably want the second without the
first.

## Decision

No document content reaches an external provider until the owner has agreed.
Consent is recorded per user with `consentVersion`, `consentedAt` and
`providerCategory`, and the UI states — before the button, in both languages —
what is sent, what is not, and that processing happens at an external provider
rather than only on PalCert's servers.

Consent is the **user's**, never the organization's. A university that
published the standard cannot grant it, and an organization never gains access
to a student's AI review by way of its standard having been used.

When the notice changes, `AI_CONSENT_VERSION` increases and the user is asked
again rather than being treated as having agreed to something they never read.
Withdrawal stops new reviews; reviews already produced stay readable, because
deleting someone's results is not what withdrawal means.

PalCert does not promise Zero Data Retention. It says retention is governed by
its agreement with the provider, which is the honest and verifiable statement;
promising a contractual configuration PalCert may not have would be worse than
saying nothing.

## Alternatives considered

**Run AI review automatically on every upload.** Rejected. It is exactly the
"do not automatically send every uploaded thesis to an external provider"
failure, and the convenience is not the user's to trade away.

**Bury disclosure in a privacy policy.** Rejected: the disclosure belongs where
the decision is made, in the words a person would use.

## Consequences

- Nothing leaves PalCert for a user who has not agreed, and the e2e suite
  asserts the provider received zero calls in that case.
- An institution cannot opt its students in.
- A changed data flow requires a fresh agreement, by construction.
