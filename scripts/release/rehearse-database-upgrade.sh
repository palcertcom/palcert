#!/usr/bin/env bash
# Rehearse a release's migrations against a copy of a real database, before
# the release exists as a frozen artifact and before production is touched.
#
#   SOURCE_BACKUP=/backups/palcert-<id> \
#   MIGRATE_IMAGE=ghcr.io/<owner>/palcert-migrate@sha256:... \
#     bash scripts/release/rehearse-database-upgrade.sh
#
# `upgrade-rehearsal.sh` deploys a frozen release over a restored installation
# and re-proves the data through the application; it needs the release's
# freeze record and the acceptance state that described the source data. A
# production backup has no such state, and a release candidate has no freeze
# record yet. This is the database half on its own, for exactly that moment:
# take a copy of the production backup, run the candidate's migration image
# against it, and prove what the migrations did and did not do.
#
# What it proves is only as real as the backup. Run on a copy of the latest
# production backup it is the pre-deployment rehearsal; run on a backup of
# test data it is a test-data rehearsal and nothing more. summary.md records
# the backup's id, label, creation time and source database so the two are
# never confused.
#
#   1. a throwaway PostgreSQL 17 (the topology's image and role script) on an
#      internal Docker network: no published port, no route out, its own
#      random password. Nothing here reads DATABASE_URL or DATABASE_ADMIN_URL,
#      so it cannot be pointed at a live database by accident;
#   2. the backup's database restored into it by the ordinary restore.mjs,
#      which validates the archive and its checksums first (objects skipped:
#      migrations do not touch the object store);
#   3. the starting point recorded:
#      - the migration history (EXPECT_SOURCE, default 81, none failed);
#      - every table's row count and content digest;
#      - the schema catalog: tables, columns and types, indexes, functions,
#        triggers, policies, enum labels and table grants;
#      - the money: every customer balance (account, currency, credit class),
#        holds, purchases, withdrawal requests, reservations and settlements,
#        attestation revenue, and every input of the platform and institution
#        withdrawal-funds computations, the way the release being replaced
#        computes them;
#   4. the candidate's migration image run once, exactly as the topology runs
#      it, then `prisma migrate status` from the same image;
#   5. the result verified:
#      - the history is the release's (EXPECT_RELEASE, default: the migrations
#        in this checkout) and verify-restore.mjs passes (RLS, policies,
#        grants, ledger, certificates);
#      - every pre-existing table holds the same rows, except tables a pending
#        migration inserts into at top level, which may only gain rows;
#      - nothing in the catalog was removed or altered; what was added is
#        listed as the intended change;
#      - every balance and commitment is unchanged, and the withdrawal-funds
#        inputs computed the new way equal the old ones, figure for figure;
#      - the service-revenue rollback gate still says COMPATIBLE.
#
# The copy is removed at the end unless KEEP=1. Logs, before/after evidence
# and summary.md stay in REHEARSAL_WORK. Exit 0 when every check holds, 65
# when one does not, 64 for missing inputs.
set -euo pipefail

SOURCE_BACKUP="${SOURCE_BACKUP:?a backup directory written by apps/api/scripts/backup.mjs is required}"
MIGRATE_IMAGE="${MIGRATE_IMAGE:?the migration image of the release under test is required}"
EXPECT_SOURCE="${EXPECT_SOURCE:-81}"
WORK="${REHEARSAL_WORK:-$(mktemp -d)}"
KEEP="${KEEP:-0}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MIGRATIONS="$REPO/packages/database/prisma/migrations"
EXPECT_RELEASE="${EXPECT_RELEASE:-$(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' | wc -l | tr -d ' ')}"
TOOLS_IMAGE="${RECOVERY_TOOLS_IMAGE:-palcert-recovery-tools:local}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
EMBEDDED_TOOLS="${RECOVERY_EMBEDDED_TOOLS:-0}"
AUTOMATIC="${AUTOMATIC_REHEARSAL:-0}"
limits=()
if [ "$AUTOMATIC" = 1 ]; then
  # The production host has 4 GiB. Each short-lived process is bounded, and
  # only the isolated PostgreSQL overlaps with one operator/migration process.
  limits=(--memory 512m --memory-swap 512m --cpus 1 --pids-limit 256)
  if [ "$EXPECT_RELEASE" != 84 ] || { [ "$EXPECT_SOURCE" != 81 ] && [ "$EXPECT_SOURCE" != 84 ]; }; then
    echo 'rehearsal: unsupported automatic schema transition' >&2
    exit 65
  fi
  [ "$EMBEDDED_TOOLS" = 1 ] || { echo 'rehearsal: automatic runs require embedded tools' >&2; exit 65; }
fi

[ -f "$SOURCE_BACKUP/backup.json" ] || { echo "rehearsal: $SOURCE_BACKUP is not a backup directory" >&2; exit 64; }
mkdir -p "$WORK"
chmod 700 "$WORK"
SUMMARY="$WORK/summary.md"

# Built on demand, and rebuilt when an older local copy predates bash.
if [ "$EMBEDDED_TOOLS" = 1 ]; then
  # The operator scripts and SDK are part of the scanned migration image.
  # Do not silently fall back to a host build when that contract is missing.
  docker run --rm --network none "${limits[@]}" "$TOOLS_IMAGE" \
    sh -c 'test -f /app/operator/apps/api/scripts/backup.mjs && pg_dump --version | grep -q " 17\."' \
    > /dev/null
elif ! docker run --rm "$TOOLS_IMAGE" bash -c true > /dev/null 2>&1; then
  docker build -q -f "$REPO/docker/tools/recovery-tools.Dockerfile" -t "$TOOLS_IMAGE" \
    "$REPO/docker/tools" > /dev/null
fi

name="palcert-db-rehearsal-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
app_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
URL="postgresql://palcert:${password}@${name}:5432/palcert"

# A step that stops the script must say so, not end the run in silence.
trap 'echo "rehearsal: FAIL stopped unexpectedly at line $LINENO" >&2' ERR

failed=0
say() {
  printf 'rehearsal: %-4s %s\n' "$1" "$2"
  printf -- '- %s %s\n' "$1" "$2" >> "$SUMMARY"
  if [ "$1" = FAIL ]; then failed=1; fi
}

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "rehearsal: KEEP=1, left running: container $name on network $name"
    return
  fi
  docker rm -f -v "$name" > /dev/null 2>&1 || true
  docker network rm "$name" > /dev/null 2>&1 || true
}
trap cleanup EXIT

tools() { # anything run against the copy runs here, on its private network
  local tools_root=/repo
  local operator_identity=()
  [ "$EMBEDDED_TOOLS" != 1 ] || tools_root=/app/operator
  [ "$EMBEDDED_TOOLS" != 1 ] || operator_identity=(--user 0:0 --cap-drop ALL --security-opt no-new-privileges)
  docker run --rm --network "$name" "${limits[@]}" "${operator_identity[@]}" -v "$REPO:/repo:ro" -v "$WORK:/work" \
    -v "$(cd "$SOURCE_BACKUP/.." && pwd):/source:ro" -w "$tools_root" "$TOOLS_IMAGE" "$@"
}
sql() { # one statement, tab-separated, read from the copy
  tools psql "$URL" --no-psqlrc --quiet --tuples-only --no-align --field-separator=$'\t' \
    -v ON_ERROR_STOP=1 -c "$1"
}
history() {
  sql "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
              count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
              coalesce(max(migration_name) FILTER (WHERE finished_at IS NOT NULL), '')
         FROM _prisma_migrations"
}
backup_fact() {
  python3 -c 'import json, sys
m = json.load(open(sys.argv[1]))
print(m.get(sys.argv[2]) or (m.get("source") or {}).get(sys.argv[2]) or "-")' \
    "$SOURCE_BACKUP/backup.json" "$1"
}

{
  echo "# Database upgrade rehearsal"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| backup id | $(backup_fact backupId) |"
  echo "| backup label | $(backup_fact label) |"
  echo "| backup created | $(backup_fact createdAt) |"
  echo "| source database | $(backup_fact databaseName) |"
  echo "| migration image | $MIGRATE_IMAGE |"
  echo "| expected | $EXPECT_SOURCE -> $EXPECT_RELEASE migrations |"
  echo
  echo "## Checks"
} > "$SUMMARY"
echo "rehearsal: $(basename "$SOURCE_BACKUP") (label $(backup_fact label)) with $MIGRATE_IMAGE (expect $EXPECT_SOURCE -> $EXPECT_RELEASE)"

# ---------------------------------------------------------------------------
# 1. The throwaway database.
# ---------------------------------------------------------------------------
docker network create --internal "$name" > /dev/null
docker run -d --name "$name" --network "$name" "${limits[@]}" \
  -e POSTGRES_USER=palcert -e POSTGRES_DB=palcert \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_APP_PASSWORD="$app_password" \
  -v "$REPO/docker/release-postgres-init.sh:/docker-entrypoint-initdb.d/10-app-role.sh:ro" \
  "$PG_IMAGE" > /dev/null
for _ in $(seq 1 120); do
  # Over TCP: the init server answers on the socket only (see the topology).
  if docker exec "$name" pg_isready -h 127.0.0.1 -p 5432 -U palcert -d palcert > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$name" pg_isready -h 127.0.0.1 -p 5432 -U palcert -d palcert > /dev/null \
  || { say FAIL "the throwaway database did not start"; exit 65; }
say ok "throwaway PostgreSQL $(sql 'SHOW server_version') on internal network $name"

# ---------------------------------------------------------------------------
# 2. The backup's database, restored the ordinary way.
# ---------------------------------------------------------------------------
if tools node apps/api/scripts/restore.mjs --from "/source/$(basename "$SOURCE_BACKUP")" \
     --to-database "$URL" --skip-objects > "$WORK/restore.log" 2>&1; then
  say ok "backup validated and its database restored ($(grep -o 'tables and rows restored in [0-9.]*s' "$WORK/restore.log" || echo restored))"
else
  say FAIL "the restore failed"; tail -20 "$WORK/restore.log" >&2; exit 65
fi

# ---------------------------------------------------------------------------
# 3. The starting point.
# ---------------------------------------------------------------------------
IFS=$'\t' read -r source_count source_broken source_head <<<"$(history)"
if [ "$source_count" = "$EXPECT_SOURCE" ] && [ "$source_broken" = "0" ]; then
  say ok "source history: $source_count migrations, none failed, head $source_head"
else
  say FAIL "source history: $source_count applied, $source_broken failed or rolled back (expected $EXPECT_SOURCE, 0)"
  exit 65
fi

# Pending migrations and the tables they write rows into at top level (inside
# a function body a statement is indented, and does not run at migration time).
applied_names="$(sql "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL")"
pending=()
for dir in "$MIGRATIONS"/[0-9]*; do
  migration="$(basename "$dir")"
  grep -qxF "$migration" <<<"$applied_names" || pending+=("$migration")
done
if [ "$AUTOMATIC" = 1 ]; then
  expected_pending='20261023000000_smartfix_ai_reservations 20261024000000_institution_service_revenue 20261025000000_financial_service_reports'
  if [ "$source_count" = 81 ]; then
    [ "${pending[*]}" = "$expected_pending" ] || { say FAIL 'unreviewed pending migrations'; exit 65; }
  else
    [ "${#pending[@]}" = 0 ] || { say FAIL 'schema changed after the reviewed 84 migrations'; exit 65; }
  fi
fi
expected_writes="$(for migration in "${pending[@]}"; do
  { grep -oiE '^INSERT INTO "?[a-z_]+"?' "$MIGRATIONS/$migration/migration.sql" || true; } |
    awk '{print $3}' | tr -d '"'
done | sort -u)"
say ok "${#pending[@]} pending: ${pending[*]}"

cat > "$WORK/fingerprint.sql" <<'SQL'
SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM public.%I t;',
              c.relname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
 ORDER BY c.relname
\gexec
SQL
fingerprint() {
  tools psql "$URL" --no-psqlrc --quiet --tuples-only --no-align --field-separator=$'\t' \
    -v ON_ERROR_STOP=1 -f /work/fingerprint.sql | sort
}
rows_of() { # every row of one table, as text, sorted
  sql "SELECT t::text FROM public.\"$1\" t" | LC_ALL=C sort
}
catalog_sql="
SELECT 'table ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
UNION ALL SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
  FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL SELECT 'index ' || indexname || ': ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
UNION ALL SELECT 'trigger ' || t.tgname || ' ON ' || c.relname || ' ' || md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL SELECT 'policy ' || policyname || ' ON ' || tablename || ' ' || cmd || ' ' || permissive || ' ' || roles::text || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname = 'public'
UNION ALL SELECT 'rls ' || c.relname || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
UNION ALL SELECT 'enum ' || t.typname || '.' || e.enumlabel
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public'
UNION ALL SELECT 'grant ' || grantee || ' ' || privilege_type || ' ON ' || table_name
  FROM information_schema.role_table_grants WHERE table_schema = 'public'"
catalog() { sql "$catalog_sql" | LC_ALL=C sort -u; }

# The money, from tables the pending migrations do not change. The same
# statement runs before and after, so any difference is the upgrade's doing.
financial_sql="
SELECT 'customer-balance', account_id::text, currency || '/' || credit_class::text, count(*)::text, sum(amount_minor_signed)::text
  FROM credit_ledger_entries GROUP BY account_id, currency, credit_class
UNION ALL SELECT 'hold', status::text, currency || '/' || credit_class::text, count(*)::text, sum(amount_minor)::text
  FROM credit_holds GROUP BY status, currency, credit_class
UNION ALL SELECT 'purchase', status::text || '/' || product_code::text, currency, count(*)::text, sum(amount_minor)::text
  FROM service_purchases GROUP BY status, product_code, currency
UNION ALL SELECT 'withdrawal-request', scope::text || '/' || status::text, currency || '/' || coalesce(organization_id::text, '-'), count(*)::text, sum(amount_minor)::text
  FROM withdrawal_requests GROUP BY scope, status, currency, organization_id
UNION ALL SELECT 'withdrawal-reservation', scope::text || '/' || status::text, currency || '/' || coalesce(organization_id::text, '-'), count(*)::text, sum(amount_minor)::text
  FROM withdrawal_reservations GROUP BY scope, status, currency, organization_id
UNION ALL SELECT 'withdrawal-settlement', scope::text, currency || '/' || coalesce(organization_id::text, '-'), count(*)::text, sum(amount_minor)::text
  FROM withdrawal_settlements GROUP BY scope, currency, organization_id
UNION ALL SELECT 'attestation-revenue', account, currency || '/' || organization_id::text, count(*)::text, sum(amount_minor)::text
  FROM attestation_revenue_entries GROUP BY account, currency, organization_id"

# Every input of WithdrawalFundsService.platform() and .organization(), at one
# fixed instant. The three the revenue release changes are computed the
# earlier release's way before and the new way after; the rest are shared.
cutoff="$(sql "SELECT now()::text")"
shared_funds_sql="
SELECT 'platform-commission', e.currency::text, '-', sum(e.amount_minor)::text
  FROM attestation_revenue_entries e JOIN attestation_settlements s ON s.id = e.settlement_id
 WHERE e.account = 'PLATFORM_COMMISSION' GROUP BY e.currency
UNION ALL
SELECT 'platform-chargeback-deficit', b.currency::text, '-', sum(-b.balance)::text
  FROM (SELECT account_id, currency, sum(amount_minor_signed) AS balance
          FROM credit_ledger_entries WHERE credit_class = 'CASH' GROUP BY account_id, currency) b
 WHERE b.balance < 0 GROUP BY b.currency
UNION ALL
SELECT 'paid-out', currency::text, scope::text || '/' || coalesce(organization_id::text, '-'), sum(amount_minor)::text
  FROM withdrawal_settlements WHERE scope IN ('PLATFORM', 'ORGANIZATION') GROUP BY scope, currency, organization_id
UNION ALL
SELECT 'reserved', currency::text, scope::text || '/' || coalesce(organization_id::text, '-'), sum(amount_minor)::text
  FROM withdrawal_reservations WHERE status = 'ACTIVE' AND scope IN ('PLATFORM', 'ORGANIZATION')
 GROUP BY scope, currency, organization_id"
old_funds_sql="
SELECT 'platform-services', a.currency::text, '-', sum(a.amount_minor)::text
  FROM service_purchase_allocations a JOIN credit_holds h ON h.id = a.hold_id
  JOIN service_purchases p ON p.id = a.purchase_id
 WHERE a.credit_class = 'CASH' AND h.status = 'CAPTURED' AND p.status IN ('DELIVERED', 'REFUNDED')
 GROUP BY a.currency
UNION ALL
SELECT 'platform-refunds', currency::text, '-', sum(amount_minor_signed)::text
  FROM credit_ledger_entries WHERE entry_type = 'SERVICE_REFUND' AND credit_class = 'CASH'
 GROUP BY currency
UNION ALL
SELECT 'institution-earned cleared/clearing', e.currency::text, e.organization_id::text,
       sum(CASE WHEN s.settled_at <= '$cutoff'::timestamptz THEN e.amount_minor ELSE 0 END)::text || '/' ||
       sum(CASE WHEN s.settled_at > '$cutoff'::timestamptz THEN e.amount_minor ELSE 0 END)::text
  FROM attestation_revenue_entries e JOIN attestation_settlements s ON s.id = e.settlement_id
 WHERE e.account = 'INSTITUTION' AND s.organization_id = e.organization_id
 GROUP BY e.currency, e.organization_id
UNION ALL $shared_funds_sql"
new_funds_sql="
SELECT 'platform-services', a.currency::text, '-', sum(a.amount_minor - coalesce(r.institution_minor, 0))::text
  FROM service_purchase_allocations a JOIN credit_holds h ON h.id = a.hold_id
  JOIN service_purchases p ON p.id = a.purchase_id
  LEFT JOIN service_revenue_entries r ON r.ledger_entry_id = h.captured_entry_id
 WHERE a.credit_class = 'CASH' AND h.status = 'CAPTURED' AND p.status IN ('DELIVERED', 'REFUNDED')
 GROUP BY a.currency
UNION ALL
SELECT 'platform-refunds', e.currency::text, '-', sum(e.amount_minor_signed + coalesce(r.institution_minor, 0))::text
  FROM credit_ledger_entries e LEFT JOIN service_revenue_entries r ON r.ledger_entry_id = e.id
 WHERE e.entry_type = 'SERVICE_REFUND' AND e.credit_class = 'CASH'
 GROUP BY e.currency
UNION ALL
SELECT 'institution-earned cleared/clearing', currency::text, organization_id::text,
       sum(CASE WHEN settled_at <= '$cutoff'::timestamptz OR amount_minor < 0 THEN amount_minor ELSE 0 END)::text || '/' ||
       sum(CASE WHEN settled_at > '$cutoff'::timestamptz AND amount_minor >= 0 THEN amount_minor ELSE 0 END)::text
  FROM (SELECT e.currency, e.organization_id, e.amount_minor, s.settled_at
          FROM attestation_revenue_entries e JOIN attestation_settlements s ON s.id = e.settlement_id
         WHERE e.account = 'INSTITUTION' AND s.organization_id = e.organization_id
        UNION ALL
        SELECT currency, organization_id, institution_minor, created_at FROM service_revenue_entries) earned
 GROUP BY currency, organization_id
UNION ALL $shared_funds_sql"

fingerprint > "$WORK/before.tsv"
catalog > "$WORK/catalog-before.txt"
sql "$financial_sql" | LC_ALL=C sort > "$WORK/financial-before.tsv"
if [ "$source_count" = 84 ]; then
  # Revenue history must NOT be evaluated as a hypothetical rollback to the
  # pre-revenue application. Compare the same current financial semantics.
  sql "$new_funds_sql" | LC_ALL=C sort > "$WORK/funds-before.tsv"
else
  sql "$old_funds_sql" | LC_ALL=C sort > "$WORK/funds-before.tsv"
fi
for table in $expected_writes; do rows_of "$table" > "$WORK/rows-before-$table.txt"; done
say ok "recorded $(wc -l < "$WORK/before.tsv" | tr -d ' ') tables ($(awk -F'\t' '{s+=$2} END {print s+0}' "$WORK/before.tsv") rows), $(wc -l < "$WORK/catalog-before.txt" | tr -d ' ') catalog entries, $(wc -l < "$WORK/financial-before.tsv" | tr -d ' ') balance and commitment totals, $(wc -l < "$WORK/funds-before.tsv" | tr -d ' ') withdrawal-funds inputs"

# ---------------------------------------------------------------------------
# 4. The candidate's migration image, as the topology runs it.
# ---------------------------------------------------------------------------
started=$(date +%s)
if docker run --rm --network "$name" "${limits[@]}" \
     -e DATABASE_ADMIN_URL="$URL?schema=public" \
     -e DATABASE_URL="postgresql://palcert_app:${app_password}@${name}:5432/palcert?schema=public" \
     "$MIGRATE_IMAGE" > "$WORK/migrate.log" 2>&1; then
  say ok "migrate deploy finished in $(( $(date +%s) - started ))s"
else
  say FAIL "migrate deploy failed"; tail -25 "$WORK/migrate.log" >&2; exit 65
fi
if docker run --rm --network "$name" "${limits[@]}" -e DATABASE_ADMIN_URL="$URL?schema=public" \
     -e DATABASE_URL="postgresql://palcert_app:${app_password}@${name}:5432/palcert?schema=public" \
     "$MIGRATE_IMAGE" node_modules/.bin/prisma migrate status --schema prisma/schema.prisma \
     > "$WORK/migrate-status.log" 2>&1; then
  say ok "prisma migrate status: up to date"
else
  say FAIL "prisma migrate status disagrees"; tail -15 "$WORK/migrate-status.log" >&2
fi

# ---------------------------------------------------------------------------
# 5. What the migrations did, and did not do.
# ---------------------------------------------------------------------------
IFS=$'\t' read -r after_count after_broken after_head <<<"$(history)"
release_head="$(basename "$(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' | sort | tail -1)")"
if [ "$after_count" = "$EXPECT_RELEASE" ] && [ "$after_broken" = "0" ] && [ "$after_head" = "$release_head" ]; then
  say ok "history: $source_count -> $after_count, none failed, head $after_head"
else
  say FAIL "history is $after_count ($after_broken failed), head $after_head; expected $EXPECT_RELEASE, $release_head"
fi
sql "SELECT migration_name, finished_at FROM _prisma_migrations
      WHERE migration_name > '$source_head' ORDER BY migration_name" > "$WORK/migrations-added.tsv"

if tools node apps/api/scripts/verify-restore.mjs --database "$URL" \
     --migrations packages/database/prisma/migrations > "$WORK/verify.log" 2>&1; then
  say ok "verify-restore: history, RLS, policies, grants, ledger and certificates"
else
  say FAIL "verify-restore failed"; tail -20 "$WORK/verify.log" >&2
fi

fingerprint > "$WORK/after.tsv"
changed=0
while IFS=$'\t' read -r table rows digest; do
  after="$(awk -F'\t' -v t="$table" '$1 == t {print $2 "\t" $3}' "$WORK/after.tsv")"
  if [ -z "$after" ]; then
    say FAIL "table $table no longer exists"; changed=1
  elif [ "$after" != "$rows"$'\t'"$digest" ]; then
    if grep -qxF "$table" <<<"$expected_writes"; then
      rows_of "$table" > "$WORK/rows-after-$table.txt"
      removed="$(LC_ALL=C comm -23 "$WORK/rows-before-$table.txt" "$WORK/rows-after-$table.txt" | wc -l | tr -d ' ')"
      added="$(LC_ALL=C comm -13 "$WORK/rows-before-$table.txt" "$WORK/rows-after-$table.txt" | wc -l | tr -d ' ')"
      if [ "$removed" = "0" ]; then
        say ok "table $table: $rows -> ${after%%$'\t'*} rows, $added added by a pending migration, none changed or removed"
      else
        say FAIL "table $table: $removed existing row(s) changed or removed"; changed=1
      fi
    else
      say FAIL "table $table changed: $rows -> ${after%%$'\t'*} rows, no pending migration writes to it"; changed=1
    fi
  fi
done < "$WORK/before.tsv"
[ "$changed" -eq 0 ] && say ok "every other pre-existing table holds exactly the rows it held before"

catalog > "$WORK/catalog-after.txt"
LC_ALL=C comm -23 "$WORK/catalog-before.txt" "$WORK/catalog-after.txt" > "$WORK/catalog-removed.txt"
LC_ALL=C comm -13 "$WORK/catalog-before.txt" "$WORK/catalog-after.txt" > "$WORK/catalog-added.txt"
if [ -s "$WORK/catalog-removed.txt" ]; then
  say FAIL "the migrations removed or altered $(wc -l < "$WORK/catalog-removed.txt" | tr -d ' ') catalog entr(y/ies); see catalog-removed.txt"
else
  say ok "catalog: nothing removed or altered; added $(awk '{print $1}' "$WORK/catalog-added.txt" | sort | uniq -c | awk '{printf "%s %s, ", $1, $2}' | sed 's/, $//')"
fi

sql "$financial_sql" | LC_ALL=C sort > "$WORK/financial-after.tsv"
if diff -u "$WORK/financial-before.tsv" "$WORK/financial-after.tsv" > "$WORK/financial.diff"; then
  say ok "balances and commitments unchanged: $(awk -F'\t' '{print $1}' "$WORK/financial-before.tsv" | sort | uniq -c | awk '{printf "%s %s, ", $1, $2}' | sed 's/, $//') totals"
else
  say FAIL "balances or commitments changed across the upgrade; see financial.diff"
fi

sql "$new_funds_sql" | LC_ALL=C sort > "$WORK/funds-after.tsv"
if diff -u "$WORK/funds-before.tsv" "$WORK/funds-after.tsv" > "$WORK/funds.diff"; then
  say ok "withdrawal funds: all $(wc -l < "$WORK/funds-after.tsv" | tr -d ' ') inputs computed the new way equal the earlier release's"
else
  say FAIL "withdrawal-funds inputs changed across the upgrade"; head -20 "$WORK/funds.diff" >&2
fi

if [ "$source_count" = 84 ] && [ "${#pending[@]}" = 0 ]; then
  # A no-schema-change deployment has no rollback-to-81 authorization. Check
  # equality of the complete catalog instead of testing a forbidden downgrade.
  if diff -u "$WORK/catalog-before.txt" "$WORK/catalog-after.txt" > "$WORK/catalog.diff"; then
    say ok 'unchanged schema: existing revenue history preserved; no downgrade authorized'
  else
    say FAIL 'a no-schema-change deployment changed the catalog'
  fi
elif tools bash scripts/release/check-service-revenue-rollback.sh "$URL" > "$WORK/rollback-gate.log" 2>&1; then
  say ok "service-revenue rollback gate: COMPATIBLE (the migrations created no institution share)"
else
  say FAIL "service-revenue rollback gate refused right after the upgrade"; tail -12 "$WORK/rollback-gate.log" >&2
fi

{
  echo
  echo "## Intended changes"
  echo
  echo "Migrations recorded:"
  echo
  sed 's/^/- /' "$WORK/migrations-added.tsv"
  echo
  echo "Rows added to existing tables (pending migrations insert at top level; no existing row changed):"
  echo
  for table in $expected_writes; do
    if [ -f "$WORK/rows-after-$table.txt" ]; then
      echo "- $table: $(LC_ALL=C comm -13 "$WORK/rows-before-$table.txt" "$WORK/rows-after-$table.txt" | wc -l | tr -d ' ') row(s)"
    fi
  done
  echo
  echo "Catalog entries added:"
  echo
  # shellcheck disable=SC2016
  sed 's/^/- `/; s/$/`/' "$WORK/catalog-added.txt"
} >> "$SUMMARY"

if [ "$failed" -ne 0 ]; then
  echo "rehearsal: the upgrade did not hold; evidence in $WORK" >&2
  exit 65
fi
echo "rehearsal: $source_head -> $after_head held; evidence and summary.md in $WORK"
