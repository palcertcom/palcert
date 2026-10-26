# Institution revenue shares

Platform administrators configure the institution percentage separately for each institution and service at `/[locale]/admin/organizations/[organizationId]/revenue-shares`. Rates accept 0–100% with two decimal places, require a reason and recent authentication, and are append-only with an optional future effective time. New permissions grant management to PALCERT_ADMIN and reading to PALCERT_ADMIN, PALCERT_FINANCE and PALCERT_AUDITOR by default.

A USD 10.00 cash-funded formatting check with a 50% institution share records USD 5.00 for the institution and USD 5.00 for PalCert. There is no actual bank transfer when this record is made; the existing separately approved withdrawal process pays the institution later.

The institution is derived from the selected standard's immutable check binding, not from the payer's membership or a client-supplied revenue recipient. Checks, SmartFix (including its early AI planning reservation), AI review and rule extraction snapshot their applicable rate when their purchase resource is created. Changing the rate cannot rewrite that snapshot. A free included SmartFix recheck has no separate purchase and earns no separate share.

Cash capture and the split commit in the same transaction. A deferred database guard requires delivery, so failure rolls back both. Only the CASH-funded portion is distributed; promotional credit is not withdrawable revenue. Calculations use integer minor units. As with existing attestation settlement, the platform share is floored and the indivisible remainder belongs to the institution. A USD 8.01 cash charge at 50% therefore records USD 4.01 for the institution and USD 4.00 for PalCert.

The database alone writes revenue snapshots and entries through fixed-path, trigger-only SECURITY DEFINER functions with public execution revoked. The application cannot insert/update/delete these records directly. The original customer ledger remains authoritative. A refund reverses the exact original shares and rounding, irrespective of today's policy. Uniqueness prevents repeat capture/refund entries. Existing full-charge-only refund policy is preserved.

Institution payout availability includes the new net shares alongside attestation earnings, using the existing clearing period. Refunds reduce cleared availability immediately; an already paid institution can have a deficit that blocks new payouts and is reported by reconciliation. Platform withdrawal funds exclude the institution share, and refund deductions exclude the institution's reversed share. Existing chargeback loss handling remains conservative and is borne by the platform; this feature does not add an institution clawback process.

Certificate attestation continues using its existing rate snapshots, settlement and two revenue accounts. The unified editor translates `institution percentage` to the complementary existing platform commission. The former attestation commission editor remains compatible; both edit the same authoritative history. No duplicate attestation accrual is created.

Institution members with `organization:withdrawal:read` see service totals and entries in the existing payouts page. Platform staff see the same financial report from the institution share page. Totals are grouped by service and currency and never aggregate incompatible currencies. No document content is exposed. Service revenue records use dual-party RLS; raw private checks, documents and purchases retain their existing user-only isolation.

## Migration and release

`20261024000000_institution_service_revenue` is additive and follows the SmartFix reservation migration. Historical purchases have no new snapshot and retain their previous economics. The default share for a newly attributed non-attestation service is 0% until configured. Existing attestation defaults and policies are preserved. The 50% Islamic University example is a test fixture, not a production financial policy change.

Production previously had 81 migrations; the combined pending SmartFix and revenue release requires 83. Preserve all existing environment/AI/TLS/compose configuration. This change is not deployment-ready until the full exact-head CI, including the new `revenue-sharing.e2e-spec.ts` and the withdrawal/isolation suites, passes. Source and image gates remain mandatory.
