# PalCert API → UI coverage

Generated from the NestJS controllers and the web client on branch `ui/figma-product-shell-v1`.
Each route is matched to the `api-client.ts` method that calls it and to the pages and
components that use that method; every route no page reaches was then classified by hand
(the reason is in the *Note* column).

## Summary

| Classification | Endpoints |
| --- | ---: |
| UI complete | 247 |
| UI incomplete | 0 |
| UI missing | 0 |
| Intentionally API-only | 22 |
| Internal/system | 8 |
| **Total** | **277** |

- **UI complete**: a page or component calls the endpoint for its purpose, with loading, empty, error and permission states.
- **UI incomplete**: reachable, but part of what the endpoint offers is not usable from the web.
- **UI missing**: a user-facing capability with no interface.
- **Intentionally API-only**: machine integrations, or reads whose data the UI already gets from a list or detail endpoint.
- **Internal/system**: probes, metrics and provider callbacks, never meant for people.

There are no *UI incomplete* or *UI missing* endpoints.

### Certificate attestation

All 41 attestation endpoints were added with their screens in the same change; see the *attestations* section.

### Closed in this pass

| Capability | Endpoint(s) | Where |
| --- | --- | --- |
| Organization certificate register (new endpoint) | `GET /organizations/:id/certificates` | /organizations/[id]/certificates |
| Download an issued certificate from the register | `POST /organizations/:id/certificates/:cid/download` | /organizations/[id]/certificates |
| Resend email confirmation | `POST /auth/email/resend` | /login, /register, /verify-email, /profile |
| Turn off two-step sign-in | `DELETE /auth/mfa` | /profile |
| Withdraw AI consent (personal) | `DELETE /ai/consent` | /profile, linked from each AI review |
| Staff console: overview (new endpoint) | `GET /admin/overview` | /admin |
| Staff console: one organization (new endpoint) | `GET /admin/organizations/:id` | /admin/organizations/[id] |
| Staff console: organizations, verification queue, decide, suspend, reactivate | `/admin/organizations/*` | /admin/organizations |
| Staff console: users, search (new `q`), suspend, reactivate, grant/remove role | `/admin/users/*` | /admin/users |
| Staff console: prices, ledger check, customer balance, adjust, payments, refunds, purchases | `/admin/finance/*` | /admin/finance |
| Publish a standard to the check catalogue | `PATCH …/standards/:id/check-availability` | standard detail |
| Edit / archive / restore a standard | `PATCH`, `POST …/archive`, `POST …/restore` | standard detail |
| Edit a draft version, archive a version, download a published snapshot | `PATCH`, `POST …/archive`, `GET …/snapshot` | version page |
| Edit a document type | `PATCH …/document-types/:id` | document types |
| Remove one role from a member; hand over ownership | `DELETE …/roles/:roleCode`, `POST …/ownership-transfer` | team |
| Rename a webhook endpoint; management log | `PUT …/description`, `GET …/operations` | webhook endpoint |
| Cancel a queued AI review | `POST /checks/:id/ai-reviews/:rid/cancel` | check page |
| Download a standard source; rule provenance | `POST …/download-authorization`, `GET …/provenance` | version page |
| Download the exact machine report | `GET /checks/:id/report/artifact` | check page |

## admin

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/organizations` | ADMIN_ORGANIZATION_READ | List all organizations | UI complete | `/admin/organizations` |
| GET | `/admin/organizations/:organizationId` | ADMIN_ORGANIZATION_READ | One organization, for staff | UI complete | `/admin/organizations/[organizationId]` |
| POST | `/admin/organizations/:organizationId/reactivate` | ADMIN_ORGANIZATION_SUSPEND | Reactivate a suspended organization | UI complete | `/admin/organizations/[organizationId]` |
| POST | `/admin/organizations/:organizationId/suspend` | ADMIN_ORGANIZATION_SUSPEND | Suspend an organization | UI complete | `/admin/organizations/[organizationId]` |
| POST | `/admin/organizations/:organizationId/verification` | ADMIN_ORGANIZATION_VERIFY | Approve or reject organization verification | UI complete | `/admin/organizations/[organizationId]` |
| GET | `/admin/organizations/verification-queue` | ADMIN_ORGANIZATION_VERIFY | Organizations awaiting verification review | UI complete | `/admin/organizations` |
| GET | `/admin/overview` | ADMIN_ORGANIZATION_READ, ADMIN_USER_READ | Platform counts for the staff dashboard | UI complete | `/admin` |
| GET | `/admin/users` | ADMIN_USER_READ | List users | UI complete | `/admin/users` |
| GET | `/admin/users/:id` | ADMIN_USER_READ | Read one user | UI complete | `/admin/finance/customers/[userId]`, `/admin/users/[userId]` |
| POST | `/admin/users/:id/reactivate` | ADMIN_USER_REACTIVATE | Reinstate a suspended user | UI complete | `/admin/users/[userId]` |
| POST | `/admin/users/:id/roles` | ADMIN_ROLE_ASSIGN | Grant a global role | UI complete | `/admin/users/[userId]` |
| DELETE | `/admin/users/:id/roles/:roleCode` | ADMIN_ROLE_REMOVE | Remove a global role | UI complete | `/admin/users/[userId]` |
| POST | `/admin/users/:id/suspend` | ADMIN_USER_SUSPEND | Suspend a user | UI complete | `/admin/users/[userId]` |
| GET | `/admin/email-settings` | ADMIN_EMAIL_SETTINGS_READ | Platform email configuration, no secrets (ADR-0146) | UI complete | `/admin/email-settings` |
| PUT | `/admin/email-settings` | ADMIN_EMAIL_SETTINGS_MANAGE + recent sign-in | Change provider, sender, encrypted credential | UI complete | `/admin/email-settings` |
| POST | `/admin/email-settings/test` | ADMIN_EMAIL_SETTINGS_TEST | Send the fixed configuration test email | UI complete | `/admin/email-settings` |
| GET | `/admin/email-deliveries` | ADMIN_EMAIL_DELIVERY_READ | Email delivery metadata, filtered and paginated | UI complete | `/admin/email-deliveries` |
| GET | `/admin/email-deliveries/:id` | ADMIN_EMAIL_DELIVERY_READ | One email delivery's metadata | API only (detail is the list row) | `/admin/email-deliveries` |

## ai

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| DELETE | `/ai/consent` | AI_REVIEW_CREATE_SELF | Withdraw your agreement to external AI processing | UI complete | `component: account-security` |
| GET | `/ai/consent` | AI_REVIEW_READ_SELF | Whether you have agreed to external AI processing | UI complete | `component: account-security`, `component: ai-review` |
| POST | `/ai/consent` | AI_REVIEW_CREATE_SELF | Agree to external AI processing | UI complete | `component: ai-review` |
| GET | `/checks/:checkId/ai-reviews` | AI_REVIEW_READ_SELF | List the AI reviews of a check | UI complete | `component: ai-review` |
| POST | `/checks/:checkId/ai-reviews` | AI_REVIEW_CREATE_SELF | Start an AI review of a completed check | UI complete | `component: ai-review` |
| GET | `/checks/:checkId/ai-reviews/:reviewId` | AI_REVIEW_READ_SELF | One AI review | UI complete | `component: ai-review` |
| GET | `/checks/:checkId/ai-reviews/:reviewId/assessments` | AI_REVIEW_READ_SELF | Advisory per-rule AI assessments | UI complete | `component: ai-review` |
| POST | `/checks/:checkId/ai-reviews/:reviewId/cancel` | AI_REVIEW_CREATE_SELF | Cancel a queued AI review | UI complete | `component: ai-review` |
| GET | `/checks/:checkId/ai-reviews/:reviewId/supplement` | AI_REVIEW_READ_SELF | The AI explanation and recommendations | UI complete | `component: ai-review` |

## api-clients

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/integration/v1/certificates/:certificateId` | authenticated | One certificate record | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/certificates/:certificateId/events` | authenticated | A certificate’s lifecycle events | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/organization` | authenticated | The organization this credential belongs to | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/revisions/:revisionId/history` | authenticated | The decision history of one revision | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/standards` | authenticated | This organization’s standards and their published versions | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/standards/:standardId` | authenticated | One standard | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/submissions` | authenticated | Official submissions sent to this organization | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/submissions/:submissionId` | authenticated | One submission and its revisions | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/integration/v1/webhook-endpoints` | authenticated | This organization’s outbound integrations | Intentionally API-only | Machine API for an organization’s own systems, authenticated with API-client credentials. Managed in the UI at /organizations/[id]/api-clients. |
| GET | `/organizations/:organizationId/api-clients` | INTEGRATION_API_CLIENT_READ (org) | List this organization’s API clients | UI complete | `/organizations/[organizationId]/api-clients` |
| POST | `/organizations/:organizationId/api-clients` | INTEGRATION_API_CLIENT_MANAGE, INTEGRATION_API_CLIENT_SECRET_ISSUE, (org) | Create an API client and mint its secret | UI complete | `/organizations/[organizationId]/api-clients` |
| GET | `/organizations/:organizationId/api-clients/:apiClientId` | INTEGRATION_API_CLIENT_READ (org) | One API client | Intentionally API-only | Every field is already in the API-client list the page shows. |
| POST | `/organizations/:organizationId/api-clients/:apiClientId/enabled` | INTEGRATION_API_CLIENT_MANAGE (org) | Enable or disable the client | UI complete | `/organizations/[organizationId]/api-clients` |
| POST | `/organizations/:organizationId/api-clients/:apiClientId/revocation` | INTEGRATION_API_CLIENT_MANAGE (org) | Revoke the client | UI complete | `/organizations/[organizationId]/api-clients` |
| POST | `/organizations/:organizationId/api-clients/:apiClientId/secret` | INTEGRATION_API_CLIENT_SECRET_ISSUE (org) | Rotate the secret | UI complete | `/organizations/[organizationId]/api-clients` |
| GET | `/organizations/:organizationId/api-clients/scopes` | INTEGRATION_API_CLIENT_READ (org) | The scope catalogue | UI complete | `/organizations/[organizationId]/api-clients` |

## auth

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/email/resend` | public | Resend the verification email | UI complete | `component: resend-verification` |
| POST | `/auth/email/verify` | public | Confirm an email address with the token from the link | UI complete | `/verify-email` |
| POST | `/auth/login` | public | Sign in with email and password | UI complete | `/login` |
| POST | `/auth/logout` | authenticated | Sign out of the current session | UI complete | `/profile`, `component: shell/account-menu` |
| POST | `/auth/logout-all` | SESSION_REVOKE_SELF | Sign out of every session, including this one | UI complete | `/sessions` |
| DELETE | `/auth/mfa` | MFA_MANAGE_SELF | Disable MFA | UI complete | `component: account-security` |
| POST | `/auth/mfa/challenge` | authenticated | Answer the MFA challenge | UI complete | `/mfa` |
| POST | `/auth/mfa/confirm` | authenticated | Confirm MFA enrollment with a code | UI complete | `/mfa/enroll` |
| POST | `/auth/mfa/enroll` | authenticated | Begin MFA enrollment | UI complete | `/mfa/enroll` |
| POST | `/auth/password/change` | PASSWORD_CHANGE_SELF | Change your password | UI complete | `/profile` |
| POST | `/auth/password/forgot` | public | Request a password reset link | UI complete | `/forgot-password` |
| POST | `/auth/password/reset` | public | Set a new password using a reset token | UI complete | `/reset-password` |
| POST | `/auth/register` | public | Register a new account | UI complete | `/register` |
| GET | `/auth/sessions` | SESSION_READ_SELF | List your own active sessions | UI complete | `/sessions` |
| DELETE | `/auth/sessions/:id` | SESSION_REVOKE_SELF | Revoke one of your own sessions | UI complete | `/sessions` |

## attestations

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/attestation-catalogue/organizations` | ATTESTATION_SUBMIT_SELF | Institutions offering attestation | UI complete | `/attestations/new` (`component: attestation-wizard`) |
| GET | `/attestation-catalogue/organizations/:organizationId/types` | ATTESTATION_SUBMIT_SELF | An institution's attestation types and fees | UI complete | `/attestations/new` |
| GET | `/attestation-requests` | ATTESTATION_READ_SELF | Your attestation requests | UI complete | `/attestations` |
| GET | `/attestation-requests/summary` | ATTESTATION_READ_SELF | Counts for your attestations | UI complete | `/attestations` |
| POST | `/attestation-requests` | ATTESTATION_SUBMIT_SELF | Start a request (draft) | UI complete | `/attestations/new` |
| GET | `/attestation-requests/:requestId` | ATTESTATION_READ_SELF | One of your requests | UI complete | `/attestations/[requestId]`, `/attestations/new?draft=` |
| PATCH | `/attestation-requests/:requestId` | ATTESTATION_SUBMIT_SELF | Edit a draft's details | UI complete | `/attestations/new?draft=` |
| GET | `/attestation-requests/:requestId/quote` | ATTESTATION_READ_SELF | Fee against your balance | UI complete | `/attestations/new` review step |
| POST | `/attestation-requests/:requestId/submit` | ATTESTATION_SUBMIT_SELF | Submit and reserve the fee | UI complete | `/attestations/new` |
| POST | `/attestation-requests/:requestId/cancel` | ATTESTATION_SUBMIT_SELF | Cancel before review | UI complete | `/attestations/[requestId]` |
| POST | `/attestation-requests/:requestId/respond` | ATTESTATION_SUBMIT_SELF | Answer the institution | UI complete | `/attestations/[requestId]` |
| GET | `/attestation-requests/:requestId/receipt` | ATTESTATION_READ_SELF | Payment receipt | UI complete | `/attestations/[requestId]` |
| GET | `/attestation-requests/:requestId/qr` | ATTESTATION_READ_SELF | QR (PNG/SVG) of the public link | UI complete | `component: attestation` (QrCode) |
| POST | `/attestation-requests/:requestId/artifacts` | ATTESTATION_SUBMIT_SELF | Start a file upload | UI complete | `/attestations/new` file step |
| POST | `/attestation-requests/:requestId/artifacts/:artifactId/finalize` | ATTESTATION_SUBMIT_SELF | Finish a file upload | UI complete | `/attestations/new` file step |
| POST | `/attestation-requests/:requestId/artifacts/:artifactId/upload-authorization` | ATTESTATION_SUBMIT_SELF | Fresh upload URL for a pending file | Intentionally API-only | The web starts a new upload instead of resuming one. |
| GET | `/attestation-requests/:requestId/artifact/download` | ATTESTATION_READ_SELF | Download your own file | UI complete | `/attestations/[requestId]` |
| GET | `/organizations/:organizationId/attestation-requests` | ATTESTATION_REQUEST_READ (org) | Attestation queue | UI complete | `/organizations/[organizationId]/attestations` |
| GET | `/organizations/:organizationId/attestation-requests/counts` | ATTESTATION_REQUEST_READ (org) | Queue tab counts | UI complete | `/organizations/[organizationId]/attestations` |
| GET | `/organizations/:organizationId/attestation-dashboard` | ATTESTATION_REQUEST_READ (org) | Attestation dashboard figures | UI complete | `/organizations/[organizationId]/attestations` |
| GET | `/organizations/:organizationId/attestation-requests/:requestId` | ATTESTATION_REQUEST_READ (org) | Review one request | UI complete | `/organizations/[organizationId]/attestations/[requestId]` |
| GET | `/organizations/:organizationId/attestation-requests/:requestId/artifact` | ATTESTATION_REQUEST_READ (org) | View/download the submitted file (audited) | UI complete | `/organizations/[organizationId]/attestations/[requestId]` |
| POST | `/organizations/:organizationId/attestation-requests/:requestId/start-review` | ATTESTATION_REQUEST_REVIEW (org) | Start review | UI complete | review page |
| POST | `/organizations/:organizationId/attestation-requests/:requestId/assign` | ATTESTATION_REQUEST_REVIEW (org) | Assign a reviewer | UI complete | review page (assign to me) |
| POST | `/organizations/:organizationId/attestation-requests/:requestId/request-information` | ATTESTATION_REQUEST_REVIEW (org) | Ask the applicant | UI complete | review page |
| POST | `/organizations/:organizationId/attestation-requests/:requestId/reject` | ATTESTATION_REQUEST_REVIEW (org) | Reject | UI complete | review page |
| POST | `/organizations/:organizationId/attestation-requests/:requestId/approve` | ATTESTATION_REQUEST_APPROVE (org) | Approve and attest | UI complete | review page (approve dialog) |
| POST | `/organizations/:organizationId/attestations/:attestationId/revoke` | ATTESTATION_RECORD_REVOKE (org) | Revoke an attestation | UI complete | review page |
| GET | `/organizations/:organizationId/attestations/:attestationId/qr` | ATTESTATION_REQUEST_READ (org) | QR of the public link | UI complete | review page |
| GET | `/organizations/:organizationId/attestation-types` | ATTESTATION_REQUEST_READ (org) | Attestation types | UI complete | `/organizations/[organizationId]/attestation-types`, queue type filter |
| POST | `/organizations/:organizationId/attestation-types` | ATTESTATION_TYPE_MANAGE (org) | Create a type | UI complete | `/organizations/[organizationId]/attestation-types` |
| GET | `/organizations/:organizationId/attestation-types/:typeId` | ATTESTATION_REQUEST_READ (org) | One type | Intentionally API-only | The type list returns the full record. |
| PATCH | `/organizations/:organizationId/attestation-types/:typeId` | ATTESTATION_TYPE_MANAGE (org) | Edit a type | UI complete | `/organizations/[organizationId]/attestation-types` |
| PUT | `/organizations/:organizationId/attestation-types/:typeId/fee` | ATTESTATION_FEE_MANAGE (org) | Change a type's fee | UI complete | `/organizations/[organizationId]/attestation-types` |
| GET | `/organizations/:organizationId/attestation-revenue` | ATTESTATION_FINANCE_READ (org) | Institution attestation revenue | UI complete | `/organizations/[organizationId]/attestation-revenue` |
| GET | `/admin/organizations/:organizationId/attestation-commission` | ADMIN_ATTESTATION_FINANCE_READ | Commission and history | UI complete | `/admin/organizations/[organizationId]/attestation-commission` |
| PUT | `/admin/organizations/:organizationId/attestation-commission` | ADMIN_ATTESTATION_COMMISSION_MANAGE | Set commission | UI complete | `/admin/organizations/[organizationId]/attestation-commission` |
| GET | `/admin/attestations/finance` | ADMIN_ATTESTATION_FINANCE_READ | Platform attestation finance | UI complete | `/admin/attestations` |
| GET | `/admin/organizations/:organizationId/attestation-revenue` | ADMIN_ATTESTATION_FINANCE_READ | An institution's attestation revenue | UI complete | `/admin/organizations/[organizationId]/attestation-commission` |
| GET | `/public/attestations/:token` | public | Verify an attestation | UI complete | `/verify/attestation/[token]` |
| POST | `/public/attestations/verify-file` | public | Check a file by its browser-computed SHA-256 | UI complete | `/verify/attestation/[token]` |

## certificates

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/certificates` | CERTIFICATE_READ_SELF | Certificates issued for your own official submissions | UI complete | `/certificates`, `component: dashboard` |
| GET | `/certificates/:certificateId` | CERTIFICATE_READ_SELF | One of your certificates | UI complete | `/certificates/[certificateId]` |
| POST | `/certificates/:certificateId/download` | CERTIFICATE_READ_SELF | Download your certificate | UI complete | `component: certificate` |
| GET | `/certificates/:certificateId/events` | CERTIFICATE_READ_SELF | What has happened to your certificate | UI complete | `/certificates/[certificateId]` |
| GET | `/certificates/revisions/:revisionId` | CERTIFICATE_READ_SELF | Whether one of your submission revisions has a certificate | UI complete | `/submissions/[submissionId]` |
| GET | `/organizations/:organizationId/certificates` | CERTIFICATE_READ (org) | The certificates this organization’s approvals produced | UI complete | `/organizations/[organizationId]/certificates` |
| GET | `/organizations/:organizationId/certificates/:certificateId` | CERTIFICATE_READ (org) | One certificate this organization’s approval produced | UI complete | `/organizations/[organizationId]/certificates/[certificateId]` |
| POST | `/organizations/:organizationId/certificates/:certificateId/download` | CERTIFICATE_READ (org) | Download the exact certificate PDF | UI complete | `/organizations/[organizationId]/certificates` |
| GET | `/organizations/:organizationId/certificates/:certificateId/events` | CERTIFICATE_READ (org) | The certificate’s lifecycle | UI complete | `/organizations/[organizationId]/certificates/[certificateId]` |
| POST | `/organizations/:organizationId/certificates/:certificateId/revocation` | CERTIFICATE_REVOKE (org) | Withdraw a certificate | UI complete | `component: certificate` |
| GET | `/public/certificates/:verificationCode` | public | Verify a certificate by its code | UI complete | `/verify/[code]` — Public verification page /verify/[code] (credential-less fetch in verifyCertificate()). |

## checks

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/catalogue/document-types/:documentTypeId/standards` | CHECK_READ_SELF | Checkable standards for a document type | UI complete | `/checks/new` |
| GET | `/catalogue/organizations` | CHECK_READ_SELF | Organizations that publish checkable standards | UI complete | `/checks/new` |
| GET | `/catalogue/organizations/:organizationId/document-types` | CHECK_READ_SELF | Document types an organization publishes standards for | UI complete | `/checks/new` |
| GET | `/catalogue/standards/:standardId` | CHECK_READ_SELF | One checkable standard | Intentionally API-only | The catalogue list carries everything the check form needs. |
| GET | `/catalogue/standards/:standardId/compatibility` | CHECK_READ_SELF | What this standard can be checked for, in this document’s format | UI complete | `component: format-compatibility` |
| GET | `/checks` | CHECK_READ_SELF | List your checks | UI complete | `/checks`, `component: dashboard` |
| POST | `/checks` | CHECK_CREATE_SELF | Start a check | UI complete | `/checks/new` |
| GET | `/checks/:checkId` | CHECK_READ_SELF | One check | UI complete | `/checks/[checkId]` |
| POST | `/checks/:checkId/cancel` | CHECK_CREATE_SELF | Cancel a check you no longer want | UI complete | `component: check-billing` |
| GET | `/checks/:checkId/report` | CHECK_READ_SELF | Report metadata and integrity hashes | UI complete | `/checks/[checkId]` |
| GET | `/checks/:checkId/report/artifact` | CHECK_READ_SELF | The immutable machine report | UI complete | `/checks/[checkId]` |
| GET | `/checks/:checkId/results` | CHECK_READ_SELF | Rule results for a completed check | UI complete | `component: check-findings` |
| POST | `/checks/:checkId/retry` | CHECK_CREATE_SELF | Retry a failed check | UI complete | `/checks/[checkId]` |

## documents

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/documents` | DOCUMENT_READ_SELF | List your documents | UI complete | `/checks/new`, `/documents`, `component: dashboard` |
| POST | `/documents` | DOCUMENT_WRITE_SELF | Create a document | UI complete | `/documents` |
| DELETE | `/documents/:documentId` | DOCUMENT_DELETE_SELF | Delete a document | UI complete | `/documents/[documentId]` |
| GET | `/documents/:documentId` | DOCUMENT_READ_SELF | Read a document | UI complete | `/documents/[documentId]` |
| PATCH | `/documents/:documentId` | DOCUMENT_WRITE_SELF | Rename a document | UI complete | `/documents/[documentId]` |
| GET | `/documents/:documentId/versions` | DOCUMENT_READ_SELF | List a document's versions | UI complete | `/documents/[documentId]` |
| POST | `/documents/:documentId/versions` | DOCUMENT_WRITE_SELF | Create the next version and authorize its upload | UI complete | `component: document-uploader` |
| GET | `/documents/:documentId/versions/:versionId` | DOCUMENT_READ_SELF | Read a version | UI complete | `component: document-uploader` |
| POST | `/documents/:documentId/versions/:versionId/cancel` | DOCUMENT_WRITE_SELF | Cancel an upload that has not been finalized | UI complete | `component: document-uploader` |
| POST | `/documents/:documentId/versions/:versionId/download-authorization` | DOCUMENT_DOWNLOAD_SELF | Authorize a download of a READY version | UI complete | `/documents/[documentId]` |
| POST | `/documents/:documentId/versions/:versionId/finalize` | DOCUMENT_WRITE_SELF | Finalize an upload | UI complete | `component: document-uploader` |
| POST | `/documents/:documentId/versions/:versionId/retry` | DOCUMENT_WRITE_SELF | Retry processing after an infrastructure failure | UI complete | `/documents/[documentId]` |
| POST | `/documents/:documentId/versions/:versionId/upload-authorizations` | DOCUMENT_WRITE_SELF | Re-issue an upload authorization | Intentionally API-only | Re-issuing an expired upload URL; the web flow uploads immediately after creating the version and retries by starting a new version. |

## extraction

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| DELETE | `/organizations/:organizationId/ai-consent` | ORGANIZATION_AI_CONSENT_MANAGE (org) | Withdraw the organization’s agreement | UI complete | `component: standard-sources` |
| GET | `/organizations/:organizationId/ai-consent` | STANDARD_EXTRACTION_READ (org) | Whether the organization has agreed to external AI processing | UI complete | `component: standard-sources` |
| POST | `/organizations/:organizationId/ai-consent` | ORGANIZATION_AI_CONSENT_MANAGE (org) | Agree, for the organization, to external AI processing | UI complete | `component: standard-sources` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/extraction-counters` | STANDARD_EXTRACTION_READ (org) | Source, run and proposal counts for a standard version | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/extractions` | STANDARD_EXTRACTION_READ (org) | The extraction history of a standard version | UI complete | `component: standard-sources` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/extractions` | STANDARD_EXTRACTION_RUN (org) | Read the sources and propose rules | UI complete | `component: standard-sources` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId` | STANDARD_EXTRACTION_READ (org) | One extraction run | Intentionally API-only | Single-run read; the panel polls the run list. |
| POST | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/cancel` | STANDARD_EXTRACTION_RUN (org) | Cancel a queued extraction | UI complete | `component: standard-sources` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/proposals` | STANDARD_PROPOSAL_REVIEW (org) | The proposals an extraction produced | UI complete | `component: rule-proposals` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/proposals/:proposalId` | STANDARD_PROPOSAL_REVIEW (org) | One proposal with the evidence it rests on | UI complete | `component: rule-proposals` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/proposals/:proposalId/accept` | STANDARD_PROPOSAL_DECIDE (org) | Accept a proposal, as proposed or as edited | UI complete | `component: rule-proposals` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/proposals/:proposalId/reject` | STANDARD_PROPOSAL_DECIDE (org) | Reject a proposal | UI complete | `component: rule-proposals` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/proposals/accept-selected` | STANDARD_PROPOSAL_DECIDE (org) | Accept several named proposals | UI complete | `component: rule-proposals` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/proposals/reject-selected` | STANDARD_PROPOSAL_DECIDE (org) | Reject several named proposals | UI complete | `component: rule-proposals` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/extractions/:runId/progress` | STANDARD_EXTRACTION_READ (org) | Where a running extraction has got to | UI complete | `component: extraction-progress` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/rules/:ruleId/provenance` | STANDARD_EXTRACTION_READ (org) | Where an accepted rule came from | UI complete | `component: rule-provenance` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/sources` | STANDARD_SOURCE_READ (org) | The guideline and template sources of a standard version | UI complete | `component: standard-sources` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/sources` | STANDARD_SOURCE_CREATE (org) | Create a source and authorize its upload | UI complete | `component: standard-sources` |
| DELETE | `/organizations/:organizationId/standard-versions/:versionId/sources/:sourceId` | STANDARD_SOURCE_DELETE (org) | Remove a source nothing depends on | UI complete | `component: standard-sources` |
| GET | `/organizations/:organizationId/standard-versions/:versionId/sources/:sourceId` | STANDARD_SOURCE_READ (org) | One source | Intentionally API-only | Single-source read; the panel polls the list, which returns the same view. |
| POST | `/organizations/:organizationId/standard-versions/:versionId/sources/:sourceId/download-authorization` | STANDARD_SOURCE_READ (org) | A short-lived signed download for an authorized member | UI complete | `component: standard-sources` |
| POST | `/organizations/:organizationId/standard-versions/:versionId/sources/:sourceId/finalize` | STANDARD_SOURCE_CREATE (org) | Finalize an upload and queue validation and scanning | UI complete | `component: standard-sources` |

## finance

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| POST | `/admin/finance/adjustments` | FINANCE_ADJUSTMENT_CREATE | Credit or debit a balance | UI complete | `/admin/finance/customers/[userId]` |
| GET | `/admin/finance/customers/:ownerUserId/balance` | FINANCE_LEDGER_READ | A customer’s balance | UI complete | `/admin/finance/customers/[userId]` |
| GET | `/admin/finance/customers/:ownerUserId/payments` | FINANCE_PAYMENT_READ | A customer’s payments | UI complete | `/admin/finance/customers/[userId]` |
| GET | `/admin/finance/customers/:ownerUserId/purchases` | FINANCE_PURCHASE_READ | What a customer bought | UI complete | `/admin/finance/customers/[userId]` |
| GET | `/admin/finance/prices` | PRICING_PRICE_READ | Every price version, current and historical | UI complete | `/admin/finance` |
| POST | `/admin/finance/prices` | PRICING_PRICE_CREATE | Draft a price | UI complete | `/admin/finance` |
| POST | `/admin/finance/prices/:priceVersionId/activate` | PRICING_PRICE_ACTIVATE | Put a price into force | UI complete | `/admin/finance` |
| POST | `/admin/finance/prices/:priceVersionId/retire` | PRICING_PRICE_ACTIVATE | Take a price out of force | UI complete | `/admin/finance` |
| POST | `/admin/finance/refunds` | FINANCE_REFUND_CREATE | Refund a payment through the provider | UI complete | `/admin/finance/customers/[userId]` |
| GET | `/admin/finance/refunds/:refundId` | FINANCE_PAYMENT_READ | One refund | UI complete | `/admin/finance` |
| GET | `/admin/finance/verify-ledger` | FINANCE_LEDGER_READ | Check the financial invariants | UI complete | `/admin/finance` |
| GET | `/balance` | BALANCE_READ_SELF | Your PalCert Balance | UI complete | `/balance`, `component: check-billing`, `component: dashboard`, `component: smartfix` |
| GET | `/balance/currencies` | BALANCE_READ_SELF | Currencies you hold a balance in | UI complete | `/admin/finance/customers/[userId]`, `/admin/finance`, `/balance` |
| GET | `/balance/holds` | BALANCE_READ_SELF | Credit currently reserved | UI complete | `/balance` |
| GET | `/balance/refunds` | BALANCE_READ_SELF | Refunds made to you | UI complete | `/balance` |
| GET | `/balance/top-ups` | BALANCE_READ_SELF | Your top-ups, newest first | UI complete | `/balance`, `component: balance-panels` |
| POST | `/balance/top-ups` | BALANCE_TOPUP_SELF | Add credit | UI complete | `component: balance-panels` |
| GET | `/balance/top-ups/:topUpId` | BALANCE_READ_SELF | One top-up | UI complete | `component: balance-panels` |
| GET | `/balance/transactions` | BALANCE_READ_SELF | Your transaction history | UI complete | `/balance` |
| GET | `/pricing/products` | authenticated | PalCert’s services | Intentionally API-only | Product catalogue; the UI shows the priced quote for the specific check instead. |
| GET | `/pricing/quote` | BALANCE_READ_SELF | Quote a service | UI complete | `component: check-billing`, `component: smartfix` |
| POST | `/webhooks/payments/:provider` | public | Payment provider webhook | Internal/system | Called by the payment provider, signature-verified. |

## health

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/health/ai` | public | AI provider availability — does NOT affect platform readiness | Internal/system | Orchestrator probe (API and worker); unauthenticated, not a user feature. |
| GET | `/health/live` | public | Liveness probe — is the process running? | Internal/system | Orchestrator probe (API and worker); unauthenticated, not a user feature. |
| GET | `/health/payments` | public | Payment provider availability — does NOT affect platform readiness | Internal/system | Orchestrator probe (API and worker); unauthenticated, not a user feature. |
| GET | `/health/ready` | public | Readiness probe — can the API serve traffic? | Internal/system | Orchestrator probe (API and worker); unauthenticated, not a user feature. |

## infrastructure

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/metrics` | public |  | Internal/system | Prometheus scrape target on the internal network. |

## notifications

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/notifications` | NOTIFICATION_READ_SELF | Your notifications, newest first | UI complete | `/notifications` |
| POST | `/notifications/:notificationId/read` | NOTIFICATION_WRITE_SELF | Mark one of yours as read | UI complete | `/notifications` |
| GET | `/notifications/preferences` | NOTIFICATION_READ_SELF | Which workflow emails PalCert sends you | UI complete | `/notifications/preferences` |
| PUT | `/notifications/preferences/:notificationType` | NOTIFICATION_PREFERENCE_WRITE_SELF | Change one email choice | UI complete | `/notifications/preferences` |
| POST | `/notifications/read-all` | NOTIFICATION_WRITE_SELF | Mark every unread notification of yours as read | UI complete | `/notifications` |
| GET | `/notifications/unread-count` | NOTIFICATION_READ_SELF | How many of your notifications are unread | UI complete | `component: notification-bell` |

## organizations

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| POST | `/invitations/accept` | PROFILE_READ_SELF | Accept an invitation | UI complete | `/invitations/accept` |
| POST | `/invitations/preview` | public | Describe an invitation before accepting it | UI complete | `/invitations/accept` |
| GET | `/organizations` | PROFILE_READ_SELF | List the organizations you belong to | UI complete | `/organizations`, `component: organization-shell`, `component: shell/shell-context` |
| POST | `/organizations` | PROFILE_READ_SELF | Create an organization | UI complete | `/organizations/new` |
| GET | `/organizations/:organizationId` | ORGANIZATION_PROFILE_READ (org) | Read an organization profile | UI complete | `component: organization-shell` |
| PATCH | `/organizations/:organizationId` | ORGANIZATION_PROFILE_UPDATE (org) | Update an organization profile | UI complete | `/organizations/[organizationId]/profile` |
| GET | `/organizations/:organizationId/invitations` | ORGANIZATION_MEMBER_READ (org) | List invitations | UI complete | `/organizations/[organizationId]/invitations` |
| POST | `/organizations/:organizationId/invitations` | ORGANIZATION_MEMBER_INVITE (org) | Invite someone to the organization | UI complete | `/organizations/[organizationId]/invitations` |
| DELETE | `/organizations/:organizationId/invitations/:invitationId` | ORGANIZATION_MEMBER_INVITE (org) | Revoke an outstanding invitation | UI complete | `/organizations/[organizationId]/invitations` |
| GET | `/organizations/:organizationId/members` | ORGANIZATION_MEMBER_READ (org) | List organization members | UI complete | `/organizations/[organizationId]/team` |
| DELETE | `/organizations/:organizationId/members/:membershipId` | ORGANIZATION_MEMBER_REMOVE (org) | Remove a member | UI complete | `/organizations/[organizationId]/team` |
| PATCH | `/organizations/:organizationId/members/:membershipId` | ORGANIZATION_MEMBER_UPDATE (org) | Suspend or reactivate a member | UI complete | `/organizations/[organizationId]/team` |
| POST | `/organizations/:organizationId/members/:membershipId/roles` | ORGANIZATION_ROLE_ASSIGN (org) | Grant an organization role | UI complete | `/organizations/[organizationId]/team` |
| DELETE | `/organizations/:organizationId/members/:membershipId/roles/:roleCode` | ORGANIZATION_ROLE_REMOVE (org) | Remove an organization role | UI complete | `/organizations/[organizationId]/team` |
| POST | `/organizations/:organizationId/ownership-transfer` | ORGANIZATION_OWNERSHIP_TRANSFER (org) | Transfer organization ownership | UI complete | `/organizations/[organizationId]/team` |
| GET | `/organizations/:organizationId/verification` | ORGANIZATION_VERIFICATION_READ (org) | Read verification status | UI complete | `/organizations/[organizationId]/verification` |
| POST | `/organizations/:organizationId/verification` | ORGANIZATION_VERIFICATION_REQUEST (org) | Request organization verification | UI complete | `/organizations/[organizationId]/verification` |

## smartfix

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| POST | `/smartfix/checks/:checkId/plan` | SMARTFIX_CREATE_SELF | Plan a correction | UI complete | `component: smartfix` |
| GET | `/smartfix/checks/:checkId/requests` | SMARTFIX_READ_SELF | Corrections of one check | UI complete | `component: smartfix` |
| GET | `/smartfix/plans/:planId` | SMARTFIX_READ_SELF | One correction plan | Intentionally API-only | The check’s SmartFix list already embeds each plan. |
| POST | `/smartfix/requests` | SMARTFIX_CREATE_SELF | Buy and start a correction | UI complete | `component: smartfix` |
| GET | `/smartfix/requests/:smartFixRequestId` | SMARTFIX_READ_SELF | One correction | Intentionally API-only | The check’s SmartFix list already embeds each request. |
| POST | `/smartfix/requests/:smartFixRequestId/cancel` | SMARTFIX_CREATE_SELF | Cancel a correction | UI complete | `component: smartfix` |
| GET | `/smartfix/requests/:smartFixRequestId/manifest` | SMARTFIX_READ_SELF | What the correction changed | UI complete | `component: smartfix` |

## standards

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/organizations/:organizationId/document-types` | STANDARD_DOCUMENT_TYPE_READ (org) | List document types | UI complete | `/organizations/[organizationId]/document-types`, `/organizations/[organizationId]/standards` |
| POST | `/organizations/:organizationId/document-types` | STANDARD_DOCUMENT_TYPE_MANAGE (org) | Create a document type | UI complete | `/organizations/[organizationId]/document-types` |
| GET | `/organizations/:organizationId/document-types/:documentTypeId` | STANDARD_DOCUMENT_TYPE_READ (org) | Read a document type | Intentionally API-only | The document-type list returns the full record. |
| PATCH | `/organizations/:organizationId/document-types/:documentTypeId` | STANDARD_DOCUMENT_TYPE_MANAGE (org) | Update a document type | UI complete | `component: standards-manage` |
| POST | `/organizations/:organizationId/document-types/:documentTypeId/archive` | STANDARD_DOCUMENT_TYPE_MANAGE (org) | Archive a document type | UI complete | `/organizations/[organizationId]/document-types` |
| POST | `/organizations/:organizationId/document-types/:documentTypeId/restore` | STANDARD_DOCUMENT_TYPE_MANAGE (org) | Restore an archived document type | UI complete | `/organizations/[organizationId]/document-types` |
| GET | `/organizations/:organizationId/standards` | STANDARD_READ (org) | List standards | UI complete | `/organizations/[organizationId]/standards` |
| POST | `/organizations/:organizationId/standards` | STANDARD_CREATE (org) | Create a standard | UI complete | `/organizations/[organizationId]/standards` |
| GET | `/organizations/:organizationId/standards/:standardId` | STANDARD_READ (org) | Read a standard | UI complete | `/organizations/[organizationId]/standards/[standardId]` |
| PATCH | `/organizations/:organizationId/standards/:standardId` | STANDARD_UPDATE (org) | Update a standard | UI complete | `component: standards-manage` |
| POST | `/organizations/:organizationId/standards/:standardId/archive` | STANDARD_ARCHIVE (org) | Archive a standard | UI complete | `component: standards-manage` |
| PATCH | `/organizations/:organizationId/standards/:standardId/check-availability` | STANDARD_CHECK_AVAILABILITY_MANAGE (org) | Publish this standard to the check catalogue, or withdraw it | UI complete | `component: standards-manage` |
| POST | `/organizations/:organizationId/standards/:standardId/restore` | STANDARD_ARCHIVE (org) | Restore an archived standard | UI complete | `component: standards-manage` |
| GET | `/organizations/:organizationId/standards/:standardId/versions` | STANDARD_READ (org) | List the versions of a standard | UI complete | `/organizations/[organizationId]/standards/[standardId]` |
| POST | `/organizations/:organizationId/standards/:standardId/versions` | STANDARD_VERSION_CREATE (org) | Create a draft version | UI complete | `/organizations/[organizationId]/standards/[standardId]` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId` | STANDARD_READ (org) | Read a standard version | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| PATCH | `/organizations/:organizationId/standards/:standardId/versions/:versionId` | STANDARD_VERSION_UPDATE (org) | Update a draft version | UI complete | `component: standards-manage` |
| POST | `/organizations/:organizationId/standards/:standardId/versions/:versionId/archive` | STANDARD_VERSION_ARCHIVE (org) | Archive a standard version | UI complete | `component: standards-manage` |
| POST | `/organizations/:organizationId/standards/:standardId/versions/:versionId/clone` | STANDARD_VERSION_CREATE (org) | Clone a version into a new draft | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| POST | `/organizations/:organizationId/standards/:standardId/versions/:versionId/publish` | STANDARD_VERSION_PUBLISH (org) | Publish a draft version, superseding the one in force | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId/rules` | STANDARD_READ (org) | List the rules of a version | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| POST | `/organizations/:organizationId/standards/:standardId/versions/:versionId/rules` | STANDARD_RULE_WRITE (org) | Add a rule to a draft | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| DELETE | `/organizations/:organizationId/standards/:standardId/versions/:versionId/rules/:ruleId` | STANDARD_RULE_WRITE (org) | Delete a rule from a draft | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId/rules/:ruleId` | STANDARD_READ (org) | Read a rule | Intentionally API-only | The version’s rule list returns full rules. |
| PATCH | `/organizations/:organizationId/standards/:standardId/versions/:versionId/rules/:ruleId` | STANDARD_RULE_WRITE (org) | Update a rule in a draft | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| POST | `/organizations/:organizationId/standards/:standardId/versions/:versionId/rules/reorder` | STANDARD_RULE_WRITE (org) | Reorder the rules of a draft | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId/snapshot` | STANDARD_READ (org) | Read the published canonical snapshot | UI complete | `component: standards-manage` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId/usage` | STANDARD_READ (org) | What relies on a version: submissions and certificates | UI complete | `component: version-lifecycle` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId/export` | STANDARD_READ (org) | Export a version as a portable package | UI complete | `component: standard-transfer` |
| POST | `/organizations/:organizationId/standards/import/preview` | STANDARD_VERSION_CREATE + STANDARD_RULE_WRITE (org) | Preview a portable package | UI complete | `/organizations/[organizationId]/standards/import` |
| POST | `/organizations/:organizationId/standards/import` | STANDARD_VERSION_CREATE + STANDARD_RULE_WRITE (org) | Import a previewed package as a draft | UI complete | `/organizations/[organizationId]/standards/import` |
| GET | `/organizations/:organizationId/standards/:standardId/versions/:versionId/validation` | STANDARD_READ (org) | Validate a draft without publishing it | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |
| GET | `/standards/rule-schema` | GlobalPROFILE_READ_SELF | Describe the rule schema | UI complete | `/organizations/[organizationId]/standards/[standardId]/versions/[versionId]` |

## submissions

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/organizations/:organizationId/submissions` | SUBMISSION_READ (org) | The review queue | UI complete | `/organizations/[organizationId]/submissions` |
| GET | `/organizations/:organizationId/submissions/:submissionId` | SUBMISSION_READ (org) | One submission and every revision of it received | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| GET | `/organizations/:organizationId/submissions/revisions/:revisionId/comments` | SUBMISSION_READ (org) | The comments written on one revision | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| POST | `/organizations/:organizationId/submissions/revisions/:revisionId/comments` | SUBMISSION_COMMENT (org) | Write a comment the author will read | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| POST | `/organizations/:organizationId/submissions/revisions/:revisionId/decision` | SUBMISSION_DECIDE (org) | Record the institution’s decision | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| POST | `/organizations/:organizationId/submissions/revisions/:revisionId/document` | SUBMISSION_EVIDENCE_READ (org) | Open the submitted document | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| GET | `/organizations/:organizationId/submissions/revisions/:revisionId/history` | SUBMISSION_READ (org) | The append-only decision history of one revision | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| POST | `/organizations/:organizationId/submissions/revisions/:revisionId/report` | SUBMISSION_EVIDENCE_READ (org) | Open the submitted technical report | UI complete | `/organizations/[organizationId]/submissions/[submissionId]` |
| GET | `/submissions` | SUBMISSION_READ_SELF | Your official submissions | UI complete | `/submissions`, `component: dashboard` |
| POST | `/submissions` | SUBMISSION_CREATE_SELF | Submit a check officially | UI complete | `component: submission` |
| GET | `/submissions/:submissionId` | SUBMISSION_READ_SELF | One of your official submissions | UI complete | `/submissions/[submissionId]` |
| GET | `/submissions/checks/:checkId/disclosure` | SUBMISSION_READ_SELF | What submitting this check would share | UI complete | `component: submission` |
| GET | `/submissions/revisions/:revisionId/comments` | SUBMISSION_READ_SELF | The institution’s comments on one revision | UI complete | `/submissions/[submissionId]` |
| POST | `/submissions/revisions/:revisionId/document` | SUBMISSION_READ_SELF | Download the exact bytes you submitted | UI complete | `/submissions/[submissionId]` |
| GET | `/submissions/revisions/:revisionId/history` | SUBMISSION_READ_SELF | What the institution has done with one revision | UI complete | `/submissions/[submissionId]` |
| POST | `/submissions/revisions/:revisionId/report` | SUBMISSION_READ_SELF | Download the exact report you submitted | UI complete | `/submissions/[submissionId]` |

## users

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/users/me` | PROFILE_READ_SELF | Get the authenticated user | UI complete | `/profile`, `component: shell/shell-context` |
| PATCH | `/users/me` | PROFILE_UPDATE_SELF | Update your own profile | UI complete | `/profile` |

## webhooks

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| POST | `/webhooks/resend` | Public, Svix-signed | Resend delivery events (ADR-0146) | Machine-to-machine | none |
| GET | `/organizations/:organizationId/webhooks/deliveries` | INTEGRATION_WEBHOOK_READ (org) | Delivery history, newest first | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/deliveries/:deliveryId/attempts` | INTEGRATION_WEBHOOK_READ (org) | Every network attempt for one delivery | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/deliveries/:deliveryId/replay` | INTEGRATION_WEBHOOK_REPLAY (org) | Send a business event again | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/endpoints` | INTEGRATION_WEBHOOK_READ (org) | This organization’s webhook endpoints | UI complete | `/organizations/[organizationId]/webhooks` |
| POST | `/organizations/:organizationId/webhooks/endpoints` | INTEGRATION_WEBHOOK_MANAGE (org) | Create an endpoint and its first configuration | UI complete | `/organizations/[organizationId]/webhooks` |
| GET | `/organizations/:organizationId/webhooks/endpoints/:endpointId` | INTEGRATION_WEBHOOK_READ (org) | One endpoint, with whatever is waiting to be verified | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/endpoints/:endpointId/config-versions` | INTEGRATION_WEBHOOK_READ (org) | Every configuration this endpoint has had | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| PUT | `/organizations/:organizationId/webhooks/endpoints/:endpointId/description` | INTEGRATION_WEBHOOK_MANAGE (org) | Rename an endpoint | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/endpoints/:endpointId/disable` | INTEGRATION_WEBHOOK_MANAGE (org) | Turn the integration off for good | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/endpoints/:endpointId/operations` | INTEGRATION_WEBHOOK_READ (org) | The durable management intents recorded for this endpoint | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/endpoints/:endpointId/pause` | INTEGRATION_WEBHOOK_MANAGE (org) | Stop sending, keep the configuration | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/endpoints/:endpointId/resume` | INTEGRATION_WEBHOOK_MANAGE (org) | Start sending again | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/endpoints/:endpointId/rotate-secret` | INTEGRATION_WEBHOOK_SECRET_ROTATE (org) | Mint a new signing secret | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/endpoints/:endpointId/rotation-pending` | INTEGRATION_WEBHOOK_READ (org) | How much traffic still carries the previous configuration | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/endpoints/:endpointId/subscriptions` | INTEGRATION_WEBHOOK_READ (org) | Which event types this endpoint receives | Intentionally API-only | Subscribed event types are in the endpoint detail; editing uses PUT on the same path. |
| PUT | `/organizations/:organizationId/webhooks/endpoints/:endpointId/subscriptions` | INTEGRATION_WEBHOOK_MANAGE (org) | Replace the subscription set | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/endpoints/:endpointId/test` | INTEGRATION_WEBHOOK_MANAGE (org) | Send a signed control message | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| PUT | `/organizations/:organizationId/webhooks/endpoints/:endpointId/url` | INTEGRATION_WEBHOOK_MANAGE (org) | Point the endpoint somewhere new | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| GET | `/organizations/:organizationId/webhooks/endpoints/:endpointId/verification-attempts` | INTEGRATION_WEBHOOK_READ (org) | Every verification handshake this endpoint has had | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |
| POST | `/organizations/:organizationId/webhooks/endpoints/:endpointId/verify` | INTEGRATION_WEBHOOK_MANAGE (org) | Ask PalCert to prove the pending configuration reaches somebody | UI complete | `/organizations/[organizationId]/webhooks/[endpointId]` |

## worker

| Method | Path | Permission | Purpose | Classification | Web UI / note |
| --- | --- | --- | --- | --- | --- |
| GET | `/health/live` | public | Worker liveness — should this process be restarted? | Internal/system | Orchestrator probe (API and worker); unauthenticated, not a user feature. |
| GET | `/health/ready` | public | Worker readiness — is it safe for this worker to claim work? | Internal/system | Orchestrator probe (API and worker); unauthenticated, not a user feature. |

