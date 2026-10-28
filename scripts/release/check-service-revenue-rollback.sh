#!/usr/bin/env bash
# May the application be rolled back to a release that predates institution
# service revenue (migration 20261024000000), as far as money is concerned?
#
#   DATABASE_ADMIN_URL=... scripts/release/check-service-revenue-rollback.sh
#
# `check-rollback-safety.mjs` answers the schema question: the revenue
# migrations are additive, so an earlier release still starts. This answers
# the financial one, which a schema comparison cannot see:
#
#   - Withdrawal funds. This release subtracts each institution's share from
#     PalCert's platform funds and adds it to the institution's payout funds
#     (service_revenue_entries). An earlier release does not read that table:
#     it would count the institution's money as PalCert's and leave it out of
#     the institution's payouts.
#   - The database keeps working after an application rollback. The snapshot,
#     capture and refund triggers stay installed, so an earlier release still
#     creates shares for every rate that applies, and still settles purchases
#     whose rate was snapshotted before the rollback.
#
# So "every rate is 0% now" proves nothing: a rate that was 30% last week
# left entries, and a purchase reserved under it settles later. This check
# reads the facts instead. It refuses when any of these holds:
#
#   1. a revenue entry, capture or reversal, ever gave an institution a
#      non-zero amount;
#   2. an unsettled purchase (RESERVED, PROCESSING, RECONCILIATION_REQUIRED)
#      carries a non-zero institution rate snapshot;
#   3. a non-zero rate is in force for any institution and service;
#   4. a non-zero rate is scheduled to take effect later.
#
# Freezing withdrawals before a rollback is a sensible precaution, but it is
# not evidence: it pauses payouts, it does not make the earlier release read
# the revenue it does not know about.
#
# Read-only: one READ ONLY transaction, rolled back. The verdict is true when
# it is taken; take it after new purchases and rate changes have stopped.
#
# Exit codes: 0 compatible (or the revenue migration is not applied), 3
# refused pending a decision (the code check-rollback-safety.mjs uses), 64
# usage, 69 the database could not be read.

set -euo pipefail

url="${DATABASE_ADMIN_URL:-${1:-}}"
if [ -z "$url" ]; then
  echo "check-service-revenue-rollback: set DATABASE_ADMIN_URL (or pass a URL)" >&2
  exit 64
fi
# libpq rejects Prisma's ?schema= parameter; drop it and keep any others.
url="$(printf '%s' "$url" | sed -E -e 's/\?schema=[^&]*&/?/' -e 's/[?&]schema=[^&]*//' -e 's/\?$//')"

query() {
  PGOPTIONS='-c default_transaction_read_only=on' psql "$url" --no-psqlrc --quiet \
    --tuples-only --no-align --field-separator=$'\t' -v ON_ERROR_STOP=1 -c "$1"
}

if ! applied=$(query "SELECT to_regclass('public.service_revenue_entries') IS NOT NULL"); then
  echo "check-service-revenue-rollback: could not read the database" >&2
  exit 69
fi
if [ "$applied" != "t" ]; then
  echo "service-revenue-rollback: migration 20261024000000 is not applied; no service revenue exists"
  echo "service-revenue-rollback: COMPATIBLE"
  exit 0
fi

# From here on, a failed query is an unreadable database, not a verdict.
trap 'echo "check-service-revenue-rollback: a query failed; no verdict" >&2; exit 69' ERR

blockers=0

echo "service-revenue-rollback: 1. institution amounts ever recorded (captures and reversals)"
history=$(query "
  SELECT currency,
         count(*) FILTER (WHERE institution_minor <> 0),
         coalesce(sum(institution_minor) FILTER (WHERE reversal_of_id IS NULL), 0),
         coalesce(sum(institution_minor) FILTER (WHERE reversal_of_id IS NOT NULL), 0),
         coalesce(sum(institution_minor), 0),
         count(DISTINCT organization_id) FILTER (WHERE institution_minor <> 0)
    FROM service_revenue_entries
   GROUP BY currency
  HAVING count(*) FILTER (WHERE institution_minor <> 0) > 0
   ORDER BY currency")
if [ -n "$history" ]; then
  printf '%s\n' "$history" | while IFS=$'\t' read -r currency rows captured reversed net orgs; do
    echo "  REFUSE $currency: $rows entr(y/ies) for $orgs institution(s); institution share captured $captured, reversed $reversed, net $net (minor units)"
  done
  blockers=$((blockers + 1))
else
  echo "  ok: no entry has ever given an institution a non-zero amount"
fi

echo "service-revenue-rollback: 2. unsettled purchases holding a non-zero institution rate"
inflight=$(query "
  SELECT p.status, count(*), max(s.institution_bps)
    FROM service_revenue_snapshots s
    JOIN service_purchases p ON p.id = s.purchase_id
   WHERE s.institution_bps > 0
     AND p.status IN ('RESERVED', 'PROCESSING', 'RECONCILIATION_REQUIRED')
     AND NOT EXISTS (SELECT 1 FROM service_revenue_entries e
                      WHERE e.purchase_id = s.purchase_id AND e.reversal_of_id IS NULL)
   GROUP BY p.status
   ORDER BY p.status")
if [ -n "$inflight" ]; then
  printf '%s\n' "$inflight" | while IFS=$'\t' read -r status count bps; do
    echo "  REFUSE $count purchase(s) $status with a snapshotted rate up to $bps bps; they settle with a share after a rollback"
  done
  blockers=$((blockers + 1))
else
  echo "  ok: no unsettled purchase carries a non-zero rate"
fi

echo "service-revenue-rollback: 3. non-zero rates in force now"
current=$(query "
  SELECT product_code, count(*), max(institution_bps)
    FROM (SELECT DISTINCT ON (organization_id, product_code) organization_id, product_code, institution_bps
            FROM organization_service_shares
           WHERE effective_from <= now()
           ORDER BY organization_id, product_code, effective_from DESC, created_at DESC, id DESC) latest
   WHERE institution_bps > 0
   GROUP BY product_code
   ORDER BY product_code")
if [ -n "$current" ]; then
  printf '%s\n' "$current" | while IFS=$'\t' read -r product count bps; do
    echo "  REFUSE $product: $count institution(s) at up to $bps bps; the earlier release would keep creating shares through the database triggers"
  done
  blockers=$((blockers + 1))
else
  echo "  ok: every rate in force is 0% (necessary, not sufficient)"
fi

echo "service-revenue-rollback: 4. non-zero rates scheduled for later"
future=$(query "
  SELECT count(*), coalesce(min(effective_from)::text, '')
    FROM organization_service_shares
   WHERE effective_from > now() AND institution_bps > 0")
IFS=$'\t' read -r future_count future_first <<<"$future"
if [ "$future_count" != "0" ]; then
  echo "  REFUSE $future_count scheduled non-zero rate(s), the first from $future_first"
  blockers=$((blockers + 1))
else
  echo "  ok: no non-zero rate is scheduled"
fi

echo "service-revenue-rollback: for the record (not a verdict): open withdrawal requests"
open=$(query "
  SELECT scope, status, count(*)
    FROM withdrawal_requests
   WHERE status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PROCESSING')
   GROUP BY scope, status
   ORDER BY scope, status")
if [ -n "$open" ]; then
  printf '%s\n' "$open" | while IFS=$'\t' read -r scope status count; do
    echo "  $scope $status: $count"
  done
else
  echo "  none"
fi

if [ "$blockers" -gt 0 ]; then
  echo ""
  echo "service-revenue-rollback: REFUSED — $blockers condition(s) above."
  echo "service-revenue-rollback: An earlier release would misstate platform and institution"
  echo "service-revenue-rollback: withdrawal funds. Forward-fix instead, or take a recorded"
  echo "service-revenue-rollback: finance decision with a reconciliation of the amounts above."
  echo "service-revenue-rollback: See docs/architecture/institution-service-revenue.md."
  exit 3
fi

echo ""
echo "service-revenue-rollback: COMPATIBLE — no institution share exists, is pending, or is configured."
echo "service-revenue-rollback: Keep revenue-share edits frozen until the rollback is finished;"
echo "service-revenue-rollback: the schema gate (check-rollback-safety.mjs) still applies."
