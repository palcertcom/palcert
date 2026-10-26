#!/usr/bin/env bash
# Boot a known-good release from retained artifacts alone
# (Phase 20 Checkpoints 4 and 5).
#
#   FREEZE=release-freeze.json SECRETS=secrets.env \
#     bash scripts/release/recovery-from-registry.sh
#
# Checkpoint 20.4 proved PalCert can lose its data plane and get its data
# back. This proves the other half of the same disaster: that the *software*
# can be brought back too, from things that were retained rather than things
# that are rebuilt.
#
# The distinction matters because the usual recovery plan quietly assumes an
# old commit still builds. Months later it frequently does not — a base image
# moved, a registry that hosted a dependency went away, a toolchain version
# disappeared — and that is discovered during the incident. So nothing here
# builds anything. Recovery consumes exactly four retained things:
#
#   - the restored database and object storage (Checkpoint 20.4);
#   - the release manifest and its freeze record;
#   - the five OCI image digests, pulled from the registry;
#   - the environment's secrets, including the webhook keyring.
#
# The proof is end to end: real data is created through the product's own
# workflows (`acceptance.mjs`), the data plane is destroyed, both halves are
# recovered, and the same data is read back -- and new work accepted -- from
# a system whose images were never rebuilt.
set -euo pipefail

FREEZE="${FREEZE:?release freeze record required}"
SECRETS="${SECRETS:?environment secrets file required}"
PROJECT="${RECOVERY_PROJECT:-palcert-recovery}"
WORK="${RECOVERY_WORK:-$(mktemp -d)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMPOSE="${COMPOSE_FILE:-docker/docker-compose.release.yml}"
# The backup and restore tools run inside a container on the deployment's own
# internal network, not from the host. Two reasons, and the second is the one
# that forced it:
#
#   - it is how an operator actually reaches a production data plane, which is
#     not published anywhere;
#   - `pg_dump` refuses outright when its major version is older than the
#     server's, and this host carries PostgreSQL 16 tools against a 17 server.
#     The first attempt failed with "aborting because of server version
#     mismatch", which is a tooling problem that would have looked like a
#     backup problem during a real recovery.
#
# So no ports are published and the release topology is used unmodified.
TOOLS_IMAGE="${RECOVERY_TOOLS_IMAGE:-palcert-recovery-tools:local}"
# Built here from the repository's own definition when absent (Phase 20
# Checkpoint 9 found the rehearsal depending on an image no document said how
# to make). Operator tooling, not a release artifact: nothing deployed runs
# from it, so building it does not contradict "nothing here builds anything".
if ! docker image inspect "$TOOLS_IMAGE" > /dev/null 2>&1; then
  docker build -q -f "$REPO/docker/tools/recovery-tools.Dockerfile" -t "$TOOLS_IMAGE" \
    "$REPO/docker/tools" > /dev/null
fi

MANIFEST="$(python3 -c "import json,os,sys; f=sys.argv[1]; print(os.path.join(os.path.dirname(f), json.load(open(f))['manifest']['file']))" "$FREEZE")"
VERSION="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['releaseVersion'])" "$FREEZE")"

mkdir -p "$WORK"
failed=0
say() { printf 'recovery: %-4s %s\n' "$1" "$2"; [ "$1" = FAIL ] && failed=1 || true; }

compose_cmd() {
  docker compose -p "$PROJECT" --env-file "$WORK/combined.env" -f "$COMPOSE" "$@"
}

# Run a repository tool against the deployment's data plane, from inside it.
tools() {
  docker run --rm --network "${PROJECT}_internal" \
    -v "$REPO:/repo" -v "$WORK:/work" -w /repo \
    --env-file "$WORK/tools.env" \
    "$TOOLS_IMAGE" "$@"
}

deploy() { # label
  FREEZE="$FREEZE" ENVIRONMENT_FILE="$SECRETS" COMPOSE_PROJECT_NAME="$PROJECT" \
  DEPLOY_ENVIRONMENT="recovery" \
  INSECURE_REGISTRY="${INSECURE_REGISTRY:-}" SMOKE="$HERE/staging-smoke.sh" \
    bash "$HERE/deploy.sh" "$MANIFEST" "$WORK/images.env" > "$WORK/$1.log" 2>&1
}

edge() { docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 -sk --max-time 30 "$@"; }

echo "recovery: $VERSION into $PROJECT"

node "$HERE/render-deploy-env.mjs" --manifest "$MANIFEST" --out "$WORK/images.env" > /dev/null
cat "$SECRETS" "$WORK/images.env" > "$WORK/combined.env"

PGPASSWORD_VALUE="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$SECRETS" | head -1)"

# What the tooling container needs to reach the data plane. Service names, not
# addresses: it joins the same network the application uses.
{
  echo "DATABASE_ADMIN_URL=postgresql://palcert:${PGPASSWORD_VALUE}@postgres:5432/palcert"
  echo "STORAGE_ENDPOINT=https://minio:9000"
  echo "STORAGE_REGION=us-east-1"
  echo "STORAGE_ACCESS_KEY_ID=$(sed -n 's/^STORAGE_ACCESS_KEY_ID=//p' "$SECRETS" | head -1)"
  echo "STORAGE_SECRET_ACCESS_KEY=$(sed -n 's/^STORAGE_SECRET_ACCESS_KEY=//p' "$SECRETS" | head -1)"
  echo "STORAGE_BUCKET=palcert-documents"
  echo "STORAGE_QUARANTINE_BUCKET=palcert-quarantine"
  echo "STORAGE_DERIVED_BUCKET=palcert-derived"
  echo "STORAGE_FORCE_PATH_STYLE=true"
  # The restore destination, named separately from the source on purpose
  # (Checkpoint 20.4): a restore that reuses whatever STORAGE_* happens to be
  # configured is one mistake away from writing over the installation it was
  # meant to rescue. Here they point at the same buckets because the data
  # plane was destroyed and rebuilt empty, but they still have to be stated.
  echo "RESTORE_STORAGE_ENDPOINT=https://minio:9000"
  echo "RESTORE_STORAGE_REGION=us-east-1"
  echo "RESTORE_STORAGE_ACCESS_KEY_ID=$(sed -n 's/^STORAGE_ACCESS_KEY_ID=//p' "$SECRETS" | head -1)"
  echo "RESTORE_STORAGE_SECRET_ACCESS_KEY=$(sed -n 's/^STORAGE_SECRET_ACCESS_KEY=//p' "$SECRETS" | head -1)"
  echo "RESTORE_STORAGE_BUCKET=palcert-documents"
  echo "RESTORE_STORAGE_QUARANTINE_BUCKET=palcert-quarantine"
  echo "RESTORE_STORAGE_DERIVED_BUCKET=palcert-derived"
  echo "RESTORE_STORAGE_FORCE_PATH_STYLE=true"
  # MinIO presents the certificate the `certs` job issues for the internal
  # network, which no public root signs. The rehearsal accepts it; a real
  # deployment trusts that CA instead.
  echo "NODE_TLS_REJECT_UNAUTHORIZED=0"
} > "$WORK/tools.env"
chmod 600 "$WORK/tools.env"

# ---------------------------------------------------------------------------
# 1. A running installation with real data in it.
# ---------------------------------------------------------------------------
echo "recovery: 1/7 deploying $VERSION"
compose_cmd down -v --remove-orphans > /dev/null 2>&1 || true
if deploy before; then
  say ok "$VERSION is serving"
else
  say FAIL "the initial deployment failed"; tail -25 "$WORK/before.log" >&2; exit 65
fi

echo "recovery: 2/7 creating data through the product's own workflows"
# Real work through the published surface, not an INSERT and not a single
# registration (Phase 20 Checkpoint 9). The earlier version of this step
# registered one user, which proved the database came back and nothing about
# whether the *system* did: no object in storage, no report hash, no
# certificate, no sealed webhook URL, no API client -- every one of which a
# restore can lose while the user row survives.
#
# `acceptance.mjs` builds all of them the way their users would, through the
# proxy, and leaves a 0600 state file in the work directory that step 7 uses
# to ask the recovered system the same questions. It holds rehearsal
# credentials only (throwaway accounts on a throwaway deployment).
PUBLIC_URL="$(sed -n 's/^APP_PUBLIC_WEB_URL=//p' "$SECRETS" | tail -1)"
PUBLIC_URL="${PUBLIC_URL:-https://localhost:8443}"
acceptance() {
  BASE="$PUBLIC_URL" PROJECT="$PROJECT" node "$HERE/acceptance.mjs" "$@"
}
if acceptance --out "$WORK/acceptance-before.json" --state "$WORK/acceptance-state.json" \
     > "$WORK/acceptance-before.log" 2>&1; then
  say ok "documents, checks, a certificate, an API client and a webhook exist"
else
  say FAIL "the data could not be created"; tail -15 "$WORK/acceptance-before.log" >&2; exit 65
fi

# ---------------------------------------------------------------------------
# 3. Back it up, with Checkpoint 20.4's tool and its consistency guarantees.
# ---------------------------------------------------------------------------
echo "recovery: 3/7 taking a backup"
rm -rf "$WORK/backup"
if tools node apps/api/scripts/backup.mjs \
      --out /work/backup --label recovery-from-registry > "$WORK/backup.log" 2>&1; then
  # `--out` names a parent directory; each backup lands in its own timestamped
  # subdirectory beneath it, so the tool can be pointed at one location
  # repeatedly without a new backup overwriting the last good one. The path is
  # read back from the tool rather than reconstructed from a timestamp here,
  # which would be a second implementation of the same naming rule.
  BACKUP_PATH="$(sed -n 's/^backup: written to //p' "$WORK/backup.log" | tail -1)"
  if [ -z "$BACKUP_PATH" ]; then
    say FAIL "the backup did not report where it was written"; exit 65
  fi
  say ok "backup written to ${BACKUP_PATH##*/}"
else
  say FAIL "the backup failed"; tail -20 "$WORK/backup.log" >&2; exit 65
fi

# ---------------------------------------------------------------------------
# 4. Lose the data plane. Volumes and all — this is the disaster, not a
#    restart. The images stay in the registry, which is the whole point.
# ---------------------------------------------------------------------------
echo "recovery: 4/7 destroying the data plane"
compose_cmd down -v --remove-orphans > /dev/null 2>&1 || true
if [ -z "$(docker volume ls -q --filter "name=${PROJECT}_postgres-data")" ]; then
  say ok "the database volume is gone"
else
  say FAIL "the database volume survived; this is not a disaster rehearsal"
fi

# The registry still has every digest the release names. Nothing was rebuilt
# to get here, and nothing will be.
if node "$HERE/verify-manifest.mjs" --manifest "$MANIFEST" --registry-check \
     ${INSECURE_REGISTRY:+--insecure-registry} > "$WORK/registry.log" 2>&1; then
  say ok "all five image digests are still pullable from the registry"
else
  say FAIL "the release images are no longer in the registry"
  tail -10 "$WORK/registry.log" >&2
fi

# ---------------------------------------------------------------------------
# 5. Restore into a clean data plane.
# ---------------------------------------------------------------------------
echo "recovery: 5/7 restoring into a clean data plane"
compose_cmd up -d --wait --wait-timeout 600 postgres minio > "$WORK/infra.log" 2>&1
compose_cmd up --exit-code-from storage-init storage-init >> "$WORK/infra.log" 2>&1 || true

# The destination is named explicitly rather than taken from the environment.
# That is the restore tool being careful: a restore that defaults to whatever
# database happens to be configured is one typo away from overwriting the
# installation it was supposed to rescue.
if tools node apps/api/scripts/restore.mjs --from "$BACKUP_PATH" \
      --to-database "postgresql://palcert:${PGPASSWORD_VALUE}@postgres:5432/palcert" \
      > "$WORK/restore.log" 2>&1; then
  say ok "database and objects restored"
else
  say FAIL "the restore failed"; tail -25 "$WORK/restore.log" >&2; exit 65
fi

# ---------------------------------------------------------------------------
# 6. Boot the release over the restored data plane. From digests, from the
#    registry, with no source in sight.
# ---------------------------------------------------------------------------
echo "recovery: 6/7 booting $VERSION over the restored data"
if deploy after; then
  say ok "$VERSION is serving on restored data"
else
  say FAIL "the release did not come up on restored data"; tail -30 "$WORK/after.log" >&2; exit 65
fi

node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE" --running --project "$PROJECT" \
  > /dev/null 2>&1 \
  && say ok "every running image is the frozen digest — nothing was rebuilt" \
  || say FAIL "the recovered system is not running the frozen digests"

# ---------------------------------------------------------------------------
# 7. The data came back, and the recovered system can use it.
# ---------------------------------------------------------------------------
echo "recovery: 7/7 verifying the recovered data"
# The database's own invariants: migration history against the release's
# migrations, row-level security and its policies, grants, the ledger, and the
# certificates' hashes.
if tools node apps/api/scripts/verify-restore.mjs \
      --database "postgresql://palcert:${PGPASSWORD_VALUE}@postgres:5432/palcert" \
      --migrations packages/database/prisma/migrations > "$WORK/verify-restore.log" 2>&1; then
  say ok "migrations, row-level security, grants, ledger and certificates verify"
else
  say FAIL "the restored database failed verification"; tail -20 "$WORK/verify-restore.log" >&2
fi

# And the system, through the application: the same people sign in and every
# answer is the one they got before the disaster -- byte-identical documents,
# unchanged report hashes, the same balance, a certificate that still verifies
# publicly, an API client that still authenticates, a webhook URL that still
# decrypts under the keyring, a second factor that still works -- and new work
# still flows through the recovered worker.
if acceptance --verify "$WORK/acceptance-state.json" --out "$WORK/acceptance-after.json" \
     > "$WORK/acceptance-after.log" 2>&1; then
  say ok "the recovered system gives every answer it gave before, and takes new work"
else
  say FAIL "the recovered system did not give the same answers"
  grep FAIL "$WORK/acceptance-after.log" >&2 || tail -15 "$WORK/acceptance-after.log" >&2
fi

if [ "$failed" -ne 0 ]; then
  echo "recovery: the proof did not hold; logs in $WORK" >&2
  exit 65
fi
echo "recovery: $VERSION rebuilt nothing and recovered everything — logs in $WORK"
