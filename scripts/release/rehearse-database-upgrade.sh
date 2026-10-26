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
#   1. a throwaway PostgreSQL 17 (the topology's image and role script) on an
#      internal Docker network: no published port, no route out, its own
#      random password. Nothing here reads DATABASE_URL or DATABASE_ADMIN_URL,
#      so it cannot be pointed at a live database by accident;
#   2. the backup's database restored into it by the ordinary restore.mjs,
#      which validates the archive and its checksums first (objects skipped:
#      migrations do not touch the object store);
#   3. the starting point recorded: the migration history (EXPECT_SOURCE,
#      default 81, none failed), every table's row count and content digest,
#      and the withdrawal-funds inputs computed the way the release being
#      replaced computes them;
#   4. the candidate's migration image run once, exactly as the topology runs
#      it, then `prisma migrate status` from the same image;
#   5. the result verified: the history is the release's (EXPECT_RELEASE,
#      default: the migrations in this checkout), verify-restore.mjs passes
#      (RLS, policies, grants, ledger, certificates), every table that existed
#      before has the same rows unless a pending migration inserts into it at
#      top level, the withdrawal-funds inputs computed the new way equal the
#      old figures, and the service-revenue rollback gate still says
#      COMPATIBLE (the migrations alone create no institution share).
#
# The copy is removed at the end unless KEEP=1. Logs and the before/after
# fingerprints stay in REHEARSAL_WORK. Exit 0 when every check holds, 65 when
# one does not, 64 for missing inputs.
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

[ -f "$SOURCE_BACKUP/backup.json" ] || { echo "rehearsal: $SOURCE_BACKUP is not a backup directory" >&2; exit 64; }
mkdir -p "$WORK"
chmod 700 "$WORK"

# Built on demand, and rebuilt when an older local copy predates bash.
if ! docker run --rm "$TOOLS_IMAGE" bash -c true > /dev/null 2>&1; then
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
  docker run --rm --network "$name" -v "$REPO:/repo:ro" -v "$WORK:/work" \
    -v "$(cd "$SOURCE_BACKUP/.." && pwd):/source:ro" -w /repo "$TOOLS_IMAGE" "$@"
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

echo "rehearsal: $(basename "$SOURCE_BACKUP") with $MIGRATE_IMAGE (expect $EXPECT_SOURCE -> $EXPECT_RELEASE)"

# ---------------------------------------------------------------------------
# 1. The throwaway database.
# ---------------------------------------------------------------------------
docker network create --internal "$name" > /dev/null
docker run -d --name "$name" --network "$name" \
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
fingerprint > "$WORK/before.tsv"
say ok "fingerprinted $(wc -l < "$WORK/before.tsv" | tr -d ' ') tables ($(awk -F'\t' '{s+=$2} END {print s+0}' "$WORK/before.tsv") rows)"

# Withdrawal-funds inputs at one fixed instant, so the comparison cannot drift.
cutoff="$(sql "SELECT now()::text")"
old_funds_sql="
SELECT 'platform-services', a.currency::text, '', sum(a.amount_minor)::text
  FROM service_purchase_allocations a JOIN credit_holds h ON h.id = a.hold_id
  JOIN service_purchases p ON p.id = a.purchase_id
 WHERE a.credit_class = 'CASH' AND h.status = 'CAPTURED' AND p.status IN ('DELIVERED', 'REFUNDED')
 GROUP BY a.currency
UNION ALL
SELECT 'platform-refunds', currency::text, '', sum(amount_minor_signed)::text
  FROM credit_ledger_entries WHERE entry_type = 'SERVICE_REFUND' AND credit_class = 'CASH'
 GROUP BY currency
UNION ALL
SELECT 'institution-earned', e.currency::text, e.organization_id::text,
       sum(CASE WHEN s.settled_at <= '$cutoff'::timestamptz THEN e.amount_minor ELSE 0 END)::text || '/' ||
       sum(CASE WHEN s.settled_at > '$cutoff'::timestamptz THEN e.amount_minor ELSE 0 END)::text
  FROM attestation_revenue_entries e JOIN attestation_settlements s ON s.id = e.settlement_id
 WHERE e.account = 'INSTITUTION' AND s.organization_id = e.organization_id
 GROUP BY e.currency, e.organization_id"
new_funds_sql="
SELECT 'platform-services', a.currency::text, '', sum(a.amount_minor - coalesce(r.institution_minor, 0))::text
  FROM service_purchase_allocations a JOIN credit_holds h ON h.id = a.hold_id
  JOIN service_purchases p ON p.id = a.purchase_id
  LEFT JOIN service_revenue_entries r ON r.ledger_entry_id = h.captured_entry_id
 WHERE a.credit_class = 'CASH' AND h.status = 'CAPTURED' AND p.status IN ('DELIVERED', 'REFUNDED')
 GROUP BY a.currency
UNION ALL
SELECT 'platform-refunds', e.currency::text, '', sum(e.amount_minor_signed + coalesce(r.institution_minor, 0))::text
  FROM credit_ledger_entries e LEFT JOIN service_revenue_entries r ON r.ledger_entry_id = e.id
 WHERE e.entry_type = 'SERVICE_REFUND' AND e.credit_class = 'CASH'
 GROUP BY e.currency
UNION ALL
SELECT 'institution-earned', currency::text, organization_id::text,
       sum(CASE WHEN settled_at <= '$cutoff'::timestamptz OR amount_minor < 0 THEN amount_minor ELSE 0 END)::text || '/' ||
       sum(CASE WHEN settled_at > '$cutoff'::timestamptz AND amount_minor >= 0 THEN amount_minor ELSE 0 END)::text
  FROM (SELECT e.currency, e.organization_id, e.amount_minor, s.settled_at
          FROM attestation_revenue_entries e JOIN attestation_settlements s ON s.id = e.settlement_id
         WHERE e.account = 'INSTITUTION' AND s.organization_id = e.organization_id
        UNION ALL
        SELECT currency, organization_id, institution_minor, created_at FROM service_revenue_entries) earned
 GROUP BY currency, organization_id"
sql "$old_funds_sql" | sort > "$WORK/funds-before.tsv"
say ok "withdrawal-funds inputs recorded the earlier release's way ($(wc -l < "$WORK/funds-before.tsv" | tr -d ' ') figures)"

# ---------------------------------------------------------------------------
# 4. The candidate's migration image, as the topology runs it.
# ---------------------------------------------------------------------------
started=$(date +%s)
if docker run --rm --network "$name" \
     -e DATABASE_ADMIN_URL="$URL?schema=public" \
     -e DATABASE_URL="postgresql://palcert_app:${app_password}@${name}:5432/palcert?schema=public" \
     "$MIGRATE_IMAGE" > "$WORK/migrate.log" 2>&1; then
  say ok "migrate deploy finished in $(( $(date +%s) - started ))s"
else
  say FAIL "migrate deploy failed"; tail -25 "$WORK/migrate.log" >&2; exit 65
fi
if docker run --rm --network "$name" -e DATABASE_ADMIN_URL="$URL?schema=public" \
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
      say ok "table $table: $rows -> ${after%%$'\t'*} rows (a pending migration inserts here)"
    else
      say FAIL "table $table changed: $rows -> ${after%%$'\t'*} rows, no pending migration writes to it"; changed=1
    fi
  fi
done < "$WORK/before.tsv"
[ "$changed" -eq 0 ] && say ok "every other pre-existing table holds exactly the rows it held before"
new_tables="$(awk -F'\t' 'NR == FNR {seen[$1] = 1; next} !($1 in seen) {print $1 "=" $2}' "$WORK/before.tsv" "$WORK/after.tsv" | tr '\n' ' ')"
say ok "new tables: ${new_tables:-none}"

sql "$new_funds_sql" | sort > "$WORK/funds-after.tsv"
if diff -u "$WORK/funds-before.tsv" "$WORK/funds-after.tsv" > "$WORK/funds.diff"; then
  say ok "withdrawal-funds inputs: the new release's computation equals the earlier one, figure for figure"
else
  say FAIL "withdrawal-funds inputs changed across the upgrade"; head -20 "$WORK/funds.diff" >&2
fi

if tools bash scripts/release/check-service-revenue-rollback.sh "$URL" > "$WORK/rollback-gate.log" 2>&1; then
  say ok "service-revenue rollback gate: COMPATIBLE (the migrations created no institution share)"
else
  say FAIL "service-revenue rollback gate refused right after the upgrade"; tail -12 "$WORK/rollback-gate.log" >&2
fi

if [ "$failed" -ne 0 ]; then
  echo "rehearsal: the upgrade did not hold; evidence in $WORK" >&2
  exit 65
fi
echo "rehearsal: $source_head -> $after_head held; evidence in $WORK"
