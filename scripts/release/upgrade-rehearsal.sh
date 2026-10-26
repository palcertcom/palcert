#!/usr/bin/env bash
# Upgrade a supported earlier installation to this release, and prove nothing
# was lost (Phase 20 Checkpoint 9).
#
#   FREEZE=release-freeze.json SECRETS=secrets.env \
#   SOURCE_BACKUP=<backup directory> SOURCE_STATE=<state.json> \
#     bash scripts/release/upgrade-rehearsal.sh
#
# The question is the one an operator with a running installation asks: if I
# deploy this release over my database, does my data survive, is the schema
# where the release needs it, and does everything still work? Checkpoint 20.1
# named this gate ("upgrade from the Phase 19 schema") and nothing had ever
# run it; every earlier rehearsal started from an empty database.
#
# Inputs:
#
#   SOURCE_BACKUP  a backup (apps/api/scripts/backup.mjs) of the installation
#                  being upgraded, taken at *its* schema level. For v1 that is
#                  the Phase 19 schema: 62 migrations, head
#                  20260924000100_phase19_audit_actor, with data written by
#                  the Phase 19 application itself.
#   SOURCE_STATE   what `acceptance.mjs --verify` needs to ask the upgraded
#                  installation about that data: the accounts, document
#                  fingerprints, report hashes and certificate code. 0600.
#   SECRETS        the environment's secrets -- including the key material that
#                  sealed the source data (MFA, certificate, API-client and
#                  webhook keys). An upgrade does not rotate keys.
#   FREEZE         the release being upgraded to.
#
# What it does, and why each step is there:
#
#   1. an empty data plane, from the release's own topology;
#   2. the source installation restored into it -- the stand-in for "the
#      database you already have";
#   3. proof that the database really is at the source level and that none of
#      the release's own migrations is applied, so step 4 is an upgrade and
#      not a no-op;
#   4. the release deployed over it with the ordinary `deploy.sh`: its
#      migration job applies exactly the missing migrations, once, with no
#      manual SQL, and the migration gate refuses to start the application on
#      anything else;
#   5. the database verified against the release's migrations -- history,
#      row-level security, policies, grants, ledger and certificates;
#   6. the source data read back through the upgraded application, and new
#      work accepted.
#
# There is deliberately no step 7 "and then downgrade". PalCert does not ship
# down-migrations; rollback across a migration is a restore (see
# docs/operations/release-delivery.md), and a rehearsal that pretended
# otherwise would be rehearsing something that cannot be done.
set -euo pipefail

FREEZE="${FREEZE:?release freeze record required}"
SECRETS="${SECRETS:?environment secrets file required}"
SOURCE_BACKUP="${SOURCE_BACKUP:?backup of the installation being upgraded required}"
SOURCE_STATE="${SOURCE_STATE:?state describing the source data required}"
PROJECT="${UPGRADE_PROJECT:-palcert-upgrade}"
WORK="${UPGRADE_WORK:-$(mktemp -d)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMPOSE="${COMPOSE_FILE:-docker/docker-compose.release.yml}"
TOOLS_IMAGE="${RECOVERY_TOOLS_IMAGE:-palcert-recovery-tools:local}"
if ! docker image inspect "$TOOLS_IMAGE" > /dev/null 2>&1; then
  docker build -q -f "$REPO/docker/tools/recovery-tools.Dockerfile" -t "$TOOLS_IMAGE" \
    "$REPO/docker/tools" > /dev/null
fi

MANIFEST="$(python3 -c "import json,os,sys; f=sys.argv[1]; print(os.path.join(os.path.dirname(f), json.load(open(f))['manifest']['file']))" "$FREEZE")"
VERSION="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['releaseVersion'])" "$FREEZE")"
RELEASE_HEAD="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['migration']['head'])" "$MANIFEST")"
RELEASE_COUNT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['migration']['count'])" "$MANIFEST")"

mkdir -p "$WORK"
failed=0
say() { printf 'upgrade: %-4s %s\n' "$1" "$2"; [ "$1" = FAIL ] && failed=1 || true; }

node "$HERE/render-deploy-env.mjs" --manifest "$MANIFEST" --out "$WORK/images.env" > /dev/null
cat "$SECRETS" "$WORK/images.env" > "$WORK/combined.env"
chmod 600 "$WORK/combined.env"
compose_cmd() {
  docker compose -p "$PROJECT" --env-file "$WORK/combined.env" -f "$COMPOSE" "$@"
}

PGPASSWORD_VALUE="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$SECRETS" | head -1)"
ADMIN_URL="postgresql://palcert:${PGPASSWORD_VALUE}@postgres:5432/palcert"
{
  echo "RESTORE_STORAGE_ENDPOINT=https://minio:9000"
  echo "RESTORE_STORAGE_REGION=us-east-1"
  echo "RESTORE_STORAGE_ACCESS_KEY_ID=$(sed -n 's/^STORAGE_ACCESS_KEY_ID=//p' "$SECRETS" | head -1)"
  echo "RESTORE_STORAGE_SECRET_ACCESS_KEY=$(sed -n 's/^STORAGE_SECRET_ACCESS_KEY=//p' "$SECRETS" | head -1)"
  echo "RESTORE_STORAGE_BUCKET=palcert-documents"
  echo "RESTORE_STORAGE_QUARANTINE_BUCKET=palcert-quarantine"
  echo "RESTORE_STORAGE_DERIVED_BUCKET=palcert-derived"
  echo "RESTORE_STORAGE_FORCE_PATH_STYLE=true"
  # The stack's own private CA signs MinIO's certificate; see
  # recovery-from-registry.sh for why the rehearsal accepts it.
  echo "NODE_TLS_REJECT_UNAUTHORIZED=0"
} > "$WORK/tools.env"
chmod 600 "$WORK/tools.env"

tools() {
  docker run --rm --network "${PROJECT}_internal" \
    -v "$REPO:/repo" -v "$(cd "$SOURCE_BACKUP/.." && pwd):/source:ro" -w /repo \
    --env-file "$WORK/tools.env" "$TOOLS_IMAGE" "$@"
}
applied() { # column list
  tools psql "$ADMIN_URL" --no-psqlrc -tA -c \
    "SELECT $1 FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" \
    2> /dev/null | tr -d '[:space:]'
}

echo "upgrade: $(basename "$SOURCE_BACKUP") -> $VERSION"

# ---------------------------------------------------------------------------
# 1-2. An empty data plane, then the source installation restored into it.
# ---------------------------------------------------------------------------
echo "upgrade: 1/6 an empty data plane"
compose_cmd down -v --remove-orphans > /dev/null 2>&1 || true
compose_cmd up -d --wait --wait-timeout 600 postgres minio > "$WORK/infra.log" 2>&1
compose_cmd up --exit-code-from storage-init storage-init >> "$WORK/infra.log" 2>&1 || true
say ok "postgres and object storage are up, empty"

echo "upgrade: 2/6 restoring the installation being upgraded"
if tools node apps/api/scripts/restore.mjs --from "/source/$(basename "$SOURCE_BACKUP")" \
     --to-database "$ADMIN_URL" > "$WORK/restore.log" 2>&1; then
  say ok "database and objects restored"
else
  say FAIL "the restore failed"; tail -25 "$WORK/restore.log" >&2; exit 65
fi

# ---------------------------------------------------------------------------
# 3. It really is the earlier schema.
# ---------------------------------------------------------------------------
echo "upgrade: 3/6 the starting point"
source_count="$(applied 'count(*)')"
source_head="$(applied 'max(migration_name)')"
say ok "the source database has $source_count migrations applied, head $source_head"
if [ "${source_count:-0}" -ge "$RELEASE_COUNT" ] || [ "$source_head" = "$RELEASE_HEAD" ]; then
  say FAIL "the source is already at the release's schema level; this would not be an upgrade"
  exit 65
fi
pending=$((RELEASE_COUNT - source_count))
say ok "$pending migration(s) of $VERSION are not applied yet"

# ---------------------------------------------------------------------------
# 4. Deploy the release over it, the ordinary way.
# ---------------------------------------------------------------------------
echo "upgrade: 4/6 deploying $VERSION over it"
if FREEZE="$FREEZE" ENVIRONMENT_FILE="$SECRETS" COMPOSE_PROJECT_NAME="$PROJECT" \
   DEPLOY_ENVIRONMENT="upgrade" INSECURE_REGISTRY="${INSECURE_REGISTRY:-}" \
   SMOKE="$HERE/staging-smoke.sh" \
     bash "$HERE/deploy.sh" "$MANIFEST" "$WORK/images.env" > "$WORK/deploy.log" 2>&1; then
  say ok "$VERSION deployed; its migration job ran once and the migration gate passed"
else
  say FAIL "the upgrade deployment failed"; tail -30 "$WORK/deploy.log" >&2; exit 65
fi
node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE" --running --project "$PROJECT" \
  > /dev/null 2>&1 \
  && say ok "every running image is the frozen digest" \
  || say FAIL "the upgraded system is not running the frozen digests"

# ---------------------------------------------------------------------------
# 5. The schema is exactly the release's, and the invariants hold.
# ---------------------------------------------------------------------------
echo "upgrade: 5/6 verifying the upgraded database"
after_count="$(applied 'count(*)')"
after_head="$(applied 'max(migration_name)')"
if [ "$after_count" = "$RELEASE_COUNT" ] && [ "$after_head" = "$RELEASE_HEAD" ]; then
  say ok "migration history: $source_count -> $after_count, head $after_head"
else
  say FAIL "migration history is $after_count / $after_head, expected $RELEASE_COUNT / $RELEASE_HEAD"
fi
if tools node apps/api/scripts/verify-restore.mjs --database "$ADMIN_URL" \
     --migrations packages/database/prisma/migrations > "$WORK/verify.log" 2>&1; then
  say ok "history matches the release's migrations; RLS, policies, grants, ledger and certificates verify"
else
  say FAIL "the upgraded database failed verification"; tail -20 "$WORK/verify.log" >&2
fi

# ---------------------------------------------------------------------------
# 6. The data written by the earlier release, through the new one.
# ---------------------------------------------------------------------------
echo "upgrade: 6/6 reading the earlier data through $VERSION"
PUBLIC_URL="$(sed -n 's/^APP_PUBLIC_WEB_URL=//p' "$SECRETS" | tail -1)"
if BASE="${PUBLIC_URL:-https://localhost:8443}" PROJECT="$PROJECT" \
     node "$HERE/acceptance.mjs" --verify "$SOURCE_STATE" --out "$WORK/verify-data.json" \
     > "$WORK/verify-data.log" 2>&1; then
  say ok "documents, report hashes, the certificate, the webhook keyring and tenancy all hold; new work flows"
else
  say FAIL "the earlier data is not fully usable after the upgrade"
  grep FAIL "$WORK/verify-data.log" >&2 || tail -15 "$WORK/verify-data.log" >&2
fi

if [ "$failed" -ne 0 ]; then
  echo "upgrade: the upgrade did not hold; logs in $WORK" >&2
  exit 65
fi
echo "upgrade: $source_head -> $after_head with every datum intact — logs in $WORK"
