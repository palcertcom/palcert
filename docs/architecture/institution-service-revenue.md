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

Production previously had 81 migrations; the combined pending SmartFix and revenue release requires 84: the 81 unchanged, plus `20261023000000_smartfix_ai_reservations`, `20261024000000_institution_service_revenue` and `20261025000000_financial_service_reports`, in that order. Preserve all existing environment/AI/TLS/compose configuration. This change is not deployment-ready until the full exact-head CI, including the new `revenue-sharing.e2e-spec.ts` and the withdrawal/isolation suites, passes. Source and image gates remain mandatory. Before production, run `scripts/release/rehearse-database-upgrade.sh` against a copy of the latest production backup with the release's migration image (see [release-delivery.md](../operations/release-delivery.md#upgrading-an-existing-installation)): it must take that copy from 81 to 84 migrations with every earlier row intact, the same withdrawal-funds figures, and a `COMPATIBLE` rollback gate. Building a new database from nothing is not that test.

## Rolling the application back

The three migrations are additive, so `check-rollback-safety.mjs` can be told that an earlier release tolerates the schema. That answers the schema question only. The money question is separate, and it is answered by the records, not by today's rates:

- A release before `20261024000000` does not read `service_revenue_entries`. Platform withdrawal funds would again include every institution share, and institution payout funds would again leave them out.
- An application rollback leaves the database as it is. The snapshot, capture and refund triggers keep running under the earlier release: every rate in force keeps creating shares, and a purchase reserved under a non-zero rate settles with its share later, whatever the rate is by then.

Setting every rate back to 0% is therefore not evidence that a rollback is safe; a rate that was 30% last week has left entries, and may have left purchases still to settle. Freezing withdrawals is a sensible precaution while deciding, but it is not evidence either: it pauses payouts, it does not make the earlier release count the revenue it does not know about.

Before any rollback to a release without institution revenue, after new purchases and rate changes have stopped, run the read-only gate:

```bash
DATABASE_ADMIN_URL=... scripts/release/check-service-revenue-rollback.sh
```

It refuses (exit 3) when any revenue entry, capture or reversal, ever gave an institution a non-zero amount, including histories that a refund has netted to zero; when an unsettled purchase carries a non-zero rate snapshot; or when a non-zero rate is in force or scheduled. It prints the amounts per currency and lists open withdrawal requests for the record. It exits 0 only when no institution share exists, is pending or is configured, and the schema gate still applies after it. When it refuses, forward-fix, or take a recorded finance decision backed by a reconciliation of the amounts it printed; do not override it by setting rates to 0%. `apps/api/test/revenue-rollback-check.e2e-spec.ts` proves each of these outcomes against a real database.
