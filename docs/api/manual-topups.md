# Manual top-ups API (ADR-0147)

All routes are under `/api/v1`, use the session cookie and CSRF header, and
return PalCert's standard error envelope. Amounts are minor units as decimal
strings (`"15000"` is 150.00 ILS). Write routes that create something accept
an `Idempotency-Key` header.

## Customer

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/balance/manual-payment-methods` | `balance:read:self` | Enabled methods with destination details, limits and a short-lived logo URL |
| POST | `/balance/manual-topups` | `balance:topup:self` | `{paymentMethodId, amountMinorUnits?, reference?, customerNote?}` → DRAFT; freezes the method snapshot |
| GET | `/balance/manual-topups` | `balance:read:self` | `?status&limit&cursor`, newest first |
| GET | `/balance/manual-topups/:id` | `balance:read:self` | With history; 404 for anybody else's |
| PATCH | `/balance/manual-topups/:id` | `balance:topup:self` | Draft only: `{amountMinorUnits?, reference?, customerNote?, removeReceipt?}` |
| POST | `/balance/manual-topups/:id/receipt` | `balance:topup:self` | `{originalFilename, sizeBytes, declaredMimeType?, sha256?}` → `{receipt, upload}` (presigned PUT) |
| POST | `/balance/manual-topups/:id/receipt/:receiptId/upload-url` | `balance:topup:self` | A fresh PUT URL |
| POST | `/balance/manual-topups/:id/receipt/:receiptId/finalize` | `balance:topup:self` | Attaches it and starts the scan |
| GET | `/balance/manual-topups/:id/receipt/download` | `balance:read:self` | Short-lived signed URL |
| POST | `/balance/manual-topups/:id/submit` | `balance:topup:self` | DRAFT → PENDING_REVIEW. Repeating is harmless |
| POST | `/balance/manual-topups/:id/cancel` | `balance:topup:self` | Draft, or pending with no review started |

## Payment methods (platform administration)

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/admin/payment-methods` | `admin:payment-method:read` | All, including disabled and archived, each with `reviewers` |
| GET | `/admin/payment-methods/reviewer-candidates` | `admin:payment-method:manage` | ACTIVE users holding `finance:manual-topup:review` through a platform role: id, name, email, verified, roles |
| GET | `/admin/payment-methods/:id` | `admin:payment-method:read` | |
| POST | `/admin/payment-methods` | `admin:payment-method:manage` + recent sign-in | Created disabled |
| PATCH | `/admin/payment-methods/:id` | `…:manage` + recent sign-in | Body includes `expectedVersion`; 412 when stale |
| POST | `/admin/payment-methods/:id/enable` · `/disable` · `/archive` | `…:manage` + recent sign-in | `{expectedVersion}`; archive is permanent; enable needs an eligible reviewer |
| POST | `/admin/payment-methods/:id/logo` | `…:manage` + recent sign-in | PNG/JPEG/WEBP ≤ 1 MB; SVG refused |
| POST | `/admin/payment-methods/:id/logo/:logoId/upload-url` | `…:manage` | |
| POST | `/admin/payment-methods/:id/logo/:logoId/finalize` | `…:manage` + recent sign-in | |
| POST | `/admin/payment-methods/:id/logo/remove` | `…:manage` + recent sign-in | `{expectedVersion}` |

Create and edit accept `reviewerUserIds` (up to 20 user ids). On an edit,
omitting it leaves the assignees unchanged. Each id must be an eligible
reviewer, and duplicates are refused.

Type-specific requirements: `MOBILE_WALLET` needs `mobileNumber` and
`recipientName`; `BANK_ACCOUNT` needs `bankName`, `recipientName` and an
`iban` (mod-97 checked) or `accountNumber`; `OTHER` needs instructions in
both languages.

## Review (PalCert finance)

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/admin/manual-topups` | `finance:manual-topup:read` | `?status&paymentMethodId&currency&reference&ownerUserId&limit&cursor`; oldest first; `pendingTotals` per currency; drafts never appear |
| GET | `/admin/manual-topups/:id` | `finance:manual-topup:read` | Snapshot, history with actors, owner |
| GET | `/admin/manual-topups/:id/receipt` | `finance:manual-topup:read` | Signed inline URL; audited |
| GET | `/admin/manual-topups/:id/notifications` | `admin:payment-method:manage` | Delivery report: recipients, in-app and email status, skip reason, routing, assignees not alerted; masked addresses |
| POST | `/admin/manual-topups/:id/start-review` | `finance:manual-topup:review` | Ends the owner's right to cancel |
| POST | `/admin/manual-topups/:id/approve` | `finance:manual-topup:approve` + recent sign-in | `{confirmAmountMinorUnits, confirmCurrency}` must equal the report |
| POST | `/admin/manual-topups/:id/reject` | `finance:manual-topup:reject` | `{reason, note?}`; `note` required for `OTHER` |

Rejection reasons: `REFERENCE_NOT_FOUND`, `AMOUNT_MISMATCH`,
`DUPLICATE_REFERENCE`, `RECEIPT_UNCLEAR`, `PAYMENT_NOT_RECEIVED`,
`INVALID_PAYMENT_METHOD`, `OTHER`.

## Errors

| Code | Status | When |
| --- | --- | --- |
| `MANUAL_PAYMENT_METHOD_NOT_FOUND` | 404 | Unknown or not offered |
| `MANUAL_PAYMENT_METHOD_INVALID` | 422 | Fields missing/invalid for the type |
| `MANUAL_PAYMENT_METHOD_CODE_TAKEN` | 409 | Duplicate code |
| `MANUAL_PAYMENT_METHOD_CONFLICT` | 412 | Stale `expectedVersion` |
| `MANUAL_PAYMENT_METHOD_UNAVAILABLE` | 409 | Disabled since the draft was made (draft kept) |
| `MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED` | 422 | Enabling, or emptying an offered method, without an eligible reviewer |
| `MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE` | 422 | A named reviewer lacks `finance:manual-topup:review` through a platform role |
| `MANUAL_TOPUP_NOT_FOUND` | 404 | Unknown, someone else's, or (for finance) a draft |
| `MANUAL_TOPUP_INVALID` | 422 | Submit without amount or reference |
| `MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE` | 422 | Outside the method's limits |
| `MANUAL_TOPUP_REFERENCE_INVALID` | 422 | Not 4–64 letters/digits after normalization |
| `MANUAL_TOPUP_REFERENCE_UNAVAILABLE` | 409 | Pending or credited for this method — deliberately generic |
| `MANUAL_TOPUP_TRANSITION_INVALID` | 409 | Not allowed in this state |
| `MANUAL_TOPUP_ALREADY_DECIDED` | 409 | Another decision won |
| `MANUAL_TOPUP_CONFIRMATION_REQUIRED` | 422 | Restated amount/currency differ |
| `MANUAL_TOPUP_TOO_MANY_OPEN` | 409 | Five drafts/pending already |
| `MANUAL_TOPUP_FILE_NOT_FOUND` / `_NOT_READY` / `_TYPE_NOT_ALLOWED` | 404 / 409 / 422 | Receipts and logos |
| `FORBIDDEN` | 403 | Deciding your own top-up |
