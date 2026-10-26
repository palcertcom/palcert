# Certificate attestation API

All paths are under `/api/v1`. Money is `{ currency, minorUnits }` with
`minorUnits` a decimal string. Errors use the standard envelope
(`{ error: { code, message, details?, requestId } }`), see
[conventions.md](conventions.md). Design: [attestations](../architecture/attestations.md),
[ADR-0145](../adr/0145-user-submitted-certificate-attestation.md).

> PalCert attests a submitted artifact. It does not imply PalCert originally
> issued that external certificate.

## The certificate holder

| Method | Path | Permission | |
|---|---|---|---|
| `GET` | `/attestation-catalogue/organizations` | `attestation:submit:self` | Verified, active institutions that offer at least one enabled attestation type. |
| `GET` | `/attestation-catalogue/organizations/{org}/types` | `attestation:submit:self` | That institution's enabled types (`AttestationTypePublicView`): fee, validity, required fields, formats, max size, instructions. |
| `GET` | `/attestation-requests?status=` | `attestation:read:self` | Own requests (`AttestationRequestListItemView[]`). |
| `GET` | `/attestation-requests/summary` | `attestation:read:self` | Counts: valid, expiring within 30 days, pending review, needs information, expired, rejected. |
| `POST` | `/attestation-requests` | `attestation:submit:self` | Create a DRAFT: `attestationTypeId`, `certificateTitle`, optional metadata, optional `previousAttestationId` (renewal). Header `Idempotency-Key` honoured. Throttled; limited to `ATTESTATION_MAX_OPEN_REQUESTS_PER_USER` open requests. |
| `GET` | `/attestation-requests/{id}` | `attestation:read:self` | `AttestationRequestOwnerView` (fee and payment status, never the split). |
| `PATCH` | `/attestation-requests/{id}` | `attestation:submit:self` | Edit submitted metadata; DRAFT or NEEDS_INFORMATION only. |
| `GET` | `/attestation-requests/{id}/quote` | `attestation:read:self` | Fee, available CASH balance, `sufficient`, `shortfall`. |
| `POST` | `/attestation-requests/{id}/submit` | `attestation:submit:self` | Validates required fields and a READY file, snapshots price and commission, reserves the fee. 402 `INSUFFICIENT_BALANCE` if short. Retry-safe. |
| `POST` | `/attestation-requests/{id}/cancel` | `attestation:submit:self` | DRAFT or SUBMITTED only; releases any reservation. |
| `POST` | `/attestation-requests/{id}/respond` | `attestation:submit:self` | `{ message, metadata? }` while NEEDS_INFORMATION; returns to IN_REVIEW. |
| `GET` | `/attestation-requests/{id}/receipt` | `attestation:read:self` | `AttestationReceiptView` once settled. |
| `GET` | `/attestation-requests/{id}/qr?format=png\|svg` | `attestation:read:self` | QR of the public URL (only the URL). |
| `POST` | `/attestation-requests/{id}/artifacts` | `attestation:submit:self` | `{ originalFilename, sizeBytes, declaredMimeType? }` → artifact + presigned PUT. Extension must be accepted by the type; size ≤ type limit ≤ 20 MB. |
| `POST` | `/attestation-requests/{id}/artifacts/{artifactId}/finalize` | `attestation:submit:self` | After the PUT; queues validation and scanning. |
| `POST` | `/attestation-requests/{id}/artifacts/{artifactId}/upload-authorization` | `attestation:submit:self` | A fresh PUT URL for the same pending artifact. |
| `GET` | `/attestation-requests/{id}/artifact/download` | `attestation:read:self` | Short-lived download of the owner's own file. |

## The institution

`{org}` is the organization id; the tenant guard hides organizations the caller
is not a member of (404).

| Method | Path | Permission | |
|---|---|---|---|
| `GET` | `/organizations/{org}/attestation-requests` | `attestation:request:read` | Queue. `status` = `PENDING` \| `IN_REVIEW` \| `AWAITING_INFORMATION` \| `APPROVED` \| `REJECTED` \| `REVOKED` \| `EXPIRED` \| `ALL`; filters `attestationTypeId`, `search`, `reviewerUserId`, `paymentStatus`, `validity`, `submittedFrom`, `submittedTo`; `sort` (`submittedAt`\|`updatedAt`), `order`, `cursor`, `limit` ≤ 100. Drafts never appear. |
| `GET` | `/organizations/{org}/attestation-requests/counts` | `attestation:request:read` | Per-tab counts. |
| `GET` | `/organizations/{org}/attestation-dashboard` | `attestation:request:read` | Pending, needs attention, approved/rejected this month, expiring soon; revenue only with `attestation:finance:read`. |
| `GET` | `/organizations/{org}/attestation-requests/{id}` | `attestation:request:read` | `AttestationRequestReviewView`: applicant name and email, fee snapshot with split, same-file requests **to this organization only**, type policy. |
| `GET` | `/organizations/{org}/attestation-requests/{id}/artifact?disposition=inline\|attachment` | `attestation:request:read` | Short-lived link to the submitted file. Audited (`ATTESTATION_ARTIFACT_VIEWED`). |
| `POST` | `/organizations/{org}/attestation-requests/{id}/start-review` | `attestation:request:review` | SUBMITTED → IN_REVIEW. |
| `POST` | `/organizations/{org}/attestation-requests/{id}/assign` | `attestation:request:review` | `{ reviewerUserId \| null }`. |
| `POST` | `/organizations/{org}/attestation-requests/{id}/request-information` | `attestation:request:review` | `{ message }` → NEEDS_INFORMATION. |
| `POST` | `/organizations/{org}/attestation-requests/{id}/reject` | `attestation:request:review` | `{ reason }` (shown to the applicant). Fee released. |
| `POST` | `/organizations/{org}/attestation-requests/{id}/approve` | `attestation:request:approve` | `{ confirm: true, certificateTitle, certificateType?, holderName?, issuingOrganization?, issueDate?, referenceNumber?, holderNamePublic?, referenceNumberPublic?, institutionNote?, validFrom?, validUntil? \| validityDays? \| noExpiry? }`. Re-hashes the stored file; creates the attestation; fee settled. Organization must be ACTIVE and VERIFIED. |
| `POST` | `/organizations/{org}/attestations/{attestationId}/revoke` | `attestation:record:revoke` | `{ reason }`. No automatic refund. |
| `GET` | `/organizations/{org}/attestations/{attestationId}/qr?format=png\|svg` | `attestation:request:read` | QR of the public URL. |
| `GET` | `/organizations/{org}/attestation-types` | `attestation:request:read` | All types, including disabled. |
| `POST` | `/organizations/{org}/attestation-types` | `attestation:type:manage` | Create a type (`nameEn`, `nameAr`, `currency`, `feeMinorUnits`, …). |
| `GET` | `/organizations/{org}/attestation-types/{typeId}` | `attestation:request:read` | One type. |
| `PATCH` | `/organizations/{org}/attestation-types/{typeId}` | `attestation:type:manage` | Edit (not the fee). |
| `PUT` | `/organizations/{org}/attestation-types/{typeId}/fee` | `attestation:fee:manage` | `{ currency, feeMinorUnits }`. New requests only. |
| `GET` | `/organizations/{org}/attestation-revenue` | `attestation:finance:read` | Totals per currency (gross, commission, net, pending, settled, released) and per-request lines. Filters `from`, `to`, `attestationTypeId`, `status`, `paymentStatus`, `search`, `cursor`, `limit`. |

## PalCert staff

| Method | Path | Permission | |
|---|---|---|---|
| `GET` | `/admin/organizations/{org}/attestation-commission` | `admin:attestation-finance:read` | Current rate and full history. |
| `PUT` | `/admin/organizations/{org}/attestation-commission` | `admin:attestation-commission:manage` + recent sign-in | `{ percent: "15" \| "15.5" \| "15.25", reason, effectiveFrom? }`. Appends a row. |
| `GET` | `/admin/attestations/finance?from&to&organizationId` | `admin:attestation-finance:read` | Platform totals by currency and per institution. |
| `GET` | `/admin/organizations/{org}/attestation-revenue` | `admin:attestation-finance:read` | As the institution's revenue view. |

## Public

| Method | Path | |
|---|---|---|
| `GET` | `/public/attestations/{token}` | `PublicAttestationView`. VALID, EXPIRED or REVOKED (revoked is 200, not 404). Unknown and malformed tokens: the same 404 `ATTESTATION_NOT_FOUND`. `no-store`, `noindex`, throttled per client. No file, user, email, fee, reviewer or storage key. |
| `POST` | `/public/attestations/verify-file` | `{ sha256 }` computed in the browser → `{ matched, attestations }` (VALID only). The file is never uploaded. |

Public URL shape: `${PUBLIC_WEB_URL}/verify/attestation/{token}` (the web app
redirects to the visitor's locale).

## Error codes

| Code | HTTP | When |
|---|---:|---|
| `ATTESTATION_TYPE_NOT_FOUND` | 404 | Unknown type. |
| `ATTESTATION_TYPE_DISABLED` | 409 | The type no longer accepts requests. |
| `ATTESTATION_TYPE_INVALID` | 422 | Invalid type configuration. |
| `ATTESTATION_ORGANIZATION_UNAVAILABLE` | 409 | Institution not active/verified. |
| `ATTESTATION_REQUEST_NOT_FOUND` | 404 | Not found, or not visible to the caller. |
| `ATTESTATION_TRANSITION_INVALID` | 409 | The request is not in a state that allows this. |
| `ATTESTATION_METADATA_INVALID` | 422 | Missing required field or bad value. |
| `ATTESTATION_ARTIFACT_NOT_FOUND` | 404 | Unknown artifact. |
| `ATTESTATION_ARTIFACT_NOT_READY` | 409 | Submit without a READY file. |
| `ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED` | 422 | Extension or detected format not accepted. |
| `ATTESTATION_ARTIFACT_INTEGRITY_FAILED` | 409 | Stored bytes no longer match the recorded digest, or the file changed during review. |
| `ATTESTATION_VALIDITY_INVALID` | 422 | Validity outside the type's policy. |
| `ATTESTATION_CONFIRMATION_REQUIRED` | 422 | Approval without `confirm: true`. |
| `ATTESTATION_NOT_FOUND` | 404 | Unknown attestation or public token. |
| `ATTESTATION_ALREADY_REVOKED` | 409 | Second revocation. |
| `ATTESTATION_TOO_MANY_PENDING` | 409 | Open-request limit reached. |
| `ATTESTATION_COMMISSION_INVALID` | 422 | Rate outside 0–100 or more than two decimals. |
| `INSUFFICIENT_BALANCE` | 402 | Balance below the fee at submit. |
