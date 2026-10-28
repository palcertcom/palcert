# Financial and service reports

Each signed-in individual has `/[locale]/reports`; institution owners/admins have
`/[locale]/organizations/[id]/reports`; platform financial staff have
`/[locale]/admin/reports`. Navigation follows the same permissions enforced by the
API. Reports support Arabic and English, dates, currency and (for service reports)
service and execution status. Calendar dates use the browser's IANA time zone;
SQL receives explicit timestamps with an inclusive start and exclusive end.

## Accounting meaning

- Personal financial reports use the immutable credit ledger, including top-ups,
  charges, refunds, adjustments and withdrawals. Opening and closing balances,
  credits and debits are separate for each currency and credit class.
- Institution financial reports combine institution service shares, existing
  attestation settlements, exact refund reversals and paid institution withdrawals.
- Platform financial reports combine captured CASH-funded service purchases minus
  institution shares, attestation commission, exact refund reversals and paid
  platform withdrawals. Customer top-ups and promotional funds are not revenue.
- Institution/platform balances are retained revenue ledger balances, not available
  payouts or profit and loss. Holds, clearing periods, operating expenses and
  chargeback losses are not included. Existing withdrawal screens remain authoritative
  for available payout funds. This distinction is shown on screen and in exports.
- Service reports select requests by creation time and show their **current** execution
  and payment states, quoted price, cash/promotional captures and refunds. Services
  include document checks, SmartFix (including planning reservations), AI reviews,
  rule extraction and attestations. Legacy AI rows and checks without purchases
  remain visible with unknown/unbilled money, not invented zero prices. Included
  SmartFix rechecks are activity rows, not additional paid purchases.

The count, detail page and financial balances come from one SQL statement/snapshot.
Summary amounts are calculated with PostgreSQL numeric/bigint, cast to strings
before JSON serialization and formatted without conversion to JavaScript Number.
No cross-currency total is produced. Stored financial events and original revenue
rate snapshots remain unchanged.

## Authorization and privacy

All three formats (JSON, printable full JSON, PDF) pass the same cookie authentication
and scope checks. Personal reports require `balance:read:self` and derive identity
from the session. Institution reports require verified organization membership and
`organization:withdrawal:read`. Platform reports require `admin:revenue-share:read`
(admin, finance, auditor) and audited elevation. Exports are audited; responses use
`Cache-Control: private, no-store`. Clients cannot choose another personal user id.

Migration `20261025000000_financial_service_reports` adds a read-only
`report_service_activity(from,to)` SQL function with a fixed search path and public
execution revoked. Its owner/organization/platform scope comes exclusively from
verified transaction context. Organization scope takes precedence over a member's
personal identity. Its return schema excludes student identities, filenames,
document contents, evaluation results and object storage paths. Private purchase,
check and document RLS remains unchanged. This projection is intentionally the only
cross-owner read needed for institution service reporting.

## Print and PDF

Pages contain 50 rows. Printing fetches the complete filtered dataset into a dedicated
print-only document; PDF uses the same report builder on the server. Exports with more
than 5,000 rows fail with `EXPORT_TOO_LARGE` and ask for narrower filters, rather than
silently truncating. A single requested period is at most 366 elapsed days. There is
no public export URL or persisted PDF containing account data.

PDFKit uses bundled Noto fonts, shapes logical Arabic runs and isolates Latin/numeric
runs so mixed Arabic headings cannot reverse a currency, date or amount. Landscape
A4 exports wrap cells, repeat table headers and number pages. No external font request
or browser executable is required by the API image.

## Validation and release

Tests cover permission parity across formats, range validation, exact large-money
formatting, multi-page Arabic/English PDF generation, full-data print and export-limit
errors. Real-database E2E verifies personal isolation, currency/class separation,
pagination and downloads. The institution revenue E2E also checks the 50/50 report,
refunds, content-free institution activity, unchanged private purchase RLS and other
institution isolation. These E2E suites run early in CI; the full E2E gate remains.

This migration is additive and makes no changes to production balances or share
policies. Deploy only after required exact-head checks and the release image/security
workflow pass. Production deployment remains a separate operator action.
