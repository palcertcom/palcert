#!/usr/bin/env bash
# Migration compatibility preflight, before any migration is applied
# (Phase 20 Checkpoint 5).
#
#   NETWORK=palcert-staging_internal DATABASE_ADMIN_URL=... ./migration-preflight.sh
#
# Asks one question: are the migrations this release carries a superset of the
# migrations this database already has?
#
#   empty    — never migrated at all. The normal starting state for a new
#              environment and for a restore into a clean destination.
#   behind   — the database is missing migrations this release brings. Normal:
#              that is what the migrate job is for.
#   level    — the database is already exactly here. Also normal: a redeploy
#              of the same release, or a rollback within one schema.
#   ahead    — the database has migrations this release has never heard of.
#              Refused. It means the database was migrated by a later release,
#              and starting this one against it is the failure mode Checkpoint
#              20.3 shipped: it connects, it answers readiness, and it breaks
#              only on the paths that touch what it does not know about.
#   failed   — a migration is recorded half-applied. Refused: a deployment is
#              not the place to discover that, and continuing would apply more
#              on top of a broken schema.
#
# Run before the migrate job, not after, because refusing here costs nothing:
# no schema has changed and no application container has started. The same
# check runs again after migrating, as `migrate-check` in the topology, to
# prove the job actually moved the database where it said it did.
#
# It runs inside the release's own API image, which is the only place all
# three pieces exist together at the right versions: the generated Prisma
# client, a query engine built for that image's platform, and the migration
# directory this release ships. Running it anywhere else means a client and a
# runtime that were not built for each other — the first attempt used a plain
# Node image and failed to load the query engine, which reads as "the database
# could not be reached" and is nothing of the sort.
#
# Using the release's client also makes the answer authoritative rather than
# merely indicative: the thing deciding whether the schema is compatible is
# the same code that will talk to it.
#
# Only the script and the migration names are mounted from the checkout, both
# read-only. Nothing is written, and the container has no credentials beyond
# the URL it is given.
set -euo pipefail

NETWORK="${NETWORK:?docker network of the target stack required}"
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:?admin database URL required}"
PREFLIGHT_IMAGE="${PREFLIGHT_IMAGE:?the API image of the release under test is required}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PACKAGE=/app/node_modules/@palcert/database

set +e
docker run --rm --network "$NETWORK" \
  -v "$REPO/packages/database/scripts/check-migrations.mjs:$PACKAGE/scripts/check-migrations.mjs:ro" \
  -v "$REPO/packages/database/prisma/migrations:/migrations:ro" \
  -e "DATABASE_ADMIN_URL=$DATABASE_ADMIN_URL" \
  --entrypoint node \
  "$PREFLIGHT_IMAGE" "$PACKAGE/scripts/check-migrations.mjs" --migrations /migrations
status=$?
set -e

case "$status" in
  0)
    echo "migration-preflight: the database is exactly at this release's migration level"
    ;;
  3)
    echo "migration-preflight: the database is behind this release — the migrate job has work to do"
    ;;
  6)
    # A clean environment, or a restore into an empty destination. Normal, and
    # the migrate job is what turns it into this release's schema.
    echo "migration-preflight: this database is empty — every migration is pending"
    ;;
  4)
    echo "migration-preflight: REFUSED — a migration is recorded failed or half-applied" >&2
    echo "migration-preflight: resolve the partial migration before deploying anything." >&2
    exit 65
    ;;
  5)
    echo "migration-preflight: REFUSED — the database is AHEAD of this release" >&2
    echo "migration-preflight: it holds migrations this build does not know about, so it was" >&2
    echo "migration-preflight: migrated by a later release. Deploying this one would run code" >&2
    echo "migration-preflight: against a schema it was never written for. Roll forward instead," >&2
    echo "migration-preflight: or see docs/operations/rollback.md for the rollback rules." >&2
    exit 65
    ;;
  69)
    echo "migration-preflight: the database could not be reached" >&2
    exit 69
    ;;
  78)
    echo "migration-preflight: configuration is missing" >&2
    exit 78
    ;;
  *)
    echo "migration-preflight: the check failed with status $status" >&2
    exit 65
    ;;
esac
