# ADR-0066: An institution's agreement to external AI processing is separate from a person's

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 9

## Context

ADR-0058 established that PalCert sends nothing to an external model until the
person whose document it is has agreed. That consent is personal, recorded
against a user, and given about their own manuscript.

Phase 9 sends something else entirely: an institution's guideline and template
documents, which may be unpublished policy, and which belong to the institution
rather than to any individual. Reusing the personal consent would have meant a
single student's agreement authorizing the transmission of their university's
internal documents — a category error with real consequences.

There is also a role question. A template manager uploading next year's
template is doing their job. Committing the institution to sending its
documents to a third-party processor is not the same act, and should not be a
side effect of the first.

## Decision

`OrganizationAIConsent` is a separate record, held against the organization,
versioned (`ORGANIZATION_AI_CONSENT_VERSION`), and naming the provider category
rather than a vendor, so the notice does not silently become false when the
deployment changes providers.

Granting and revoking it require `organization:ai-consent:manage`, held by
`ORGANIZATION_ADMINISTRATION` and **not** by `TEMPLATE_MANAGER` or
`STANDARD_AUTHORING`. An e2e test asserts that a template manager who can run
an extraction cannot agree to external processing on the institution's behalf.

Without organization consent, PalCert still allows source upload and the manual
Rule Builder in full. Only the reading step is blocked, and the UI says so in
the same breath as the refusal, so nobody concludes the feature is closed to
them.

Personal Phase 8 consent is untouched and is never consulted for an
organization-owned source; organization consent is never consulted for a
personal document.

## Alternatives considered

**One consent record covering both.** Rejected: different data, different
subject, different authority.

**Infer consent from the organization's contract.** Rejected: a contract is not
a record of who agreed to what, and an audit needs the latter.

## Consequences

- Two consent models exist and are tested separately, including that one
  organization's agreement says nothing about another's.
- A version bump on the notice sets `renewalRequired`, and the institution is
  asked again rather than assumed to still agree.
- Revocation is immediate and blocks the next run; it does not retroactively
  delete proposals already produced, which are the institution's own record of
  a decision it made.
