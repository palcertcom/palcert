#!/usr/bin/env bash
# Deploy a frozen release, in the order Checkpoints 20.2, 20.4 and 20.5
# established (Phase 20 Checkpoint 5).
#
#   FREEZE=release-freeze.json ./deploy.sh release-manifest.json images.env
#
# Twelve steps, and the order is the safety property rather than a
# convention:
#
#    1. validate the release manifest
#    2. verify the registry objects and provenance
#    3. verify this environment's secrets and keyrings
#    4. migration compatibility preflight
#    5. prove the configuration names the frozen digests
#    6. internal services
#    7. the migrate image, once
#    8. verify the migration state
#    9. application services
#   10. readiness and release identity
#   11. the worker
#   12. staging smoke, then ingress
#
# Ingress is last and is reached only by falling off the end. Every step
# either succeeds or exits non-zero under `set -e`, so a failure anywhere
# leaves the proxy unstarted and the release unreachable from outside. That is
# the property the negative rehearsals exercise: an unhealthy candidate does
# not receive traffic, whatever went wrong.
#
# Nothing here builds. Every image comes from `images.env` as a digest, and
# step 5 refuses to continue if any of them is not exactly the frozen one.
set -euo pipefail

MANIFEST="${1:?release manifest required}"
IMAGES_ENV="${2:?images env required}"
COMPOSE="${COMPOSE_FILE:-docker/docker-compose.release.yml}"
# An optional second compose file, layered over the release topology. The only
# supported use is a drill or rehearsal overlay — Checkpoint 20.4's, which
# publishes PostgreSQL and MinIO on loopback so backup and restore tooling can
# reach them. It never changes which images are deployed: those come from the
# manifest, and the frozen-set check would refuse anything else.
COMPOSE_OVERRIDE="${COMPOSE_OVERRIDE:-}"
compose_files=(-f "$COMPOSE")
[ -n "$COMPOSE_OVERRIDE" ] && compose_files+=(-f "$COMPOSE_OVERRIDE")
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-staging}"
PROJECT="${COMPOSE_PROJECT_NAME:-palcert-release}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Steps that need the registry. Skipped only where a rehearsal has already
# verified the same digests against the same registry in this run.
SKIP_REGISTRY_CHECK="${SKIP_REGISTRY_CHECK:-0}"
# The smoke suite. Absent means the deployment stops before ingress rather
# than opening it unverified.
SMOKE="${SMOKE:-}"
# How long to wait for a service to become healthy. Generous by default,
# because a slow start is not a failure; lowered by the negative rehearsals,
# which deliberately deploy something that will never become ready and should
# not spend seven minutes finding that out.
APP_WAIT="${DEPLOY_WAIT_TIMEOUT:-420}"
INFRA_WAIT="${DEPLOY_INFRA_WAIT_TIMEOUT:-600}"

json() { python3 -c "import json,sys;print(json.load(open('$1'))$2)"; }

# ---------------------------------------------------------------------------
# One deployment per environment, at a time.
#
# Two promotions running together is the one concurrency problem that cannot
# be recovered from by retrying: both reach the migration job, one applies
# migrations while the other is midway through its own compatibility check,
# and the database ends up somewhere neither deployment believes it is. The
# application rollout is merely wasteful when it races; the schema is not.
#
# In CI, GitHub Actions enforces this with `concurrency: deploy-<environment>`
# and `cancel-in-progress: false`, so a second run queues. Here the policy is
# to refuse immediately instead: a shell script that queued would hold a
# runner, a terminal and an operator's attention for an unbounded time, and
# an operator who is told "another deployment is in progress" can decide what
# to do far better than a process that silently waits. Both policies give the
# same guarantee, which is the one that matters: never concurrently.
#
# Exit 75 (EX_TEMPFAIL) — the request was well formed and may succeed later.
# ---------------------------------------------------------------------------
LOCK_DIR="${DEPLOY_LOCK_DIR:-${TMPDIR:-/tmp}}"
lock_file="$LOCK_DIR/palcert-deploy-${DEPLOY_ENVIRONMENT}.lock"
exec 9>"$lock_file"
if ! flock --nonblock 9; then
  echo "deploy: another deployment to $DEPLOY_ENVIRONMENT is already running" >&2
  echo "deploy: refusing to run two deployments against one environment at once" >&2
  exit 75
fi
# The lock is held for the whole deployment and released when this shell
# exits, however it exits — including a failure partway through, which is
# exactly when a second attempt is most likely and most dangerous.

release=$(json "$MANIFEST" "['releaseVersion']")
commit=$(json "$MANIFEST" "['commit']")
expected_head=$(json "$MANIFEST" "['migration']['head']")

echo "deploy: $release ($commit) -> $DEPLOY_ENVIRONMENT"

# ---------------------------------------------------------------------------
# 1. The manifest itself.
# ---------------------------------------------------------------------------
echo "deploy: 1/12 release manifest"
node "$HERE/verify-manifest.mjs" --manifest "$MANIFEST" --expect-commit "$commit" > /dev/null

# ---------------------------------------------------------------------------
# 2. The registry objects and their provenance.
# ---------------------------------------------------------------------------
if [ "$SKIP_REGISTRY_CHECK" = "1" ]; then
  echo "deploy: 2/12 registry verification (already verified in this run)"
else
  echo "deploy: 2/12 registry objects and provenance"
  node "$HERE/verify-manifest.mjs" --manifest "$MANIFEST" --registry-check \
    ${INSECURE_REGISTRY:+--insecure-registry} > /dev/null
  bash "$HERE/verify-provenance.sh" "$MANIFEST"
fi

# ---------------------------------------------------------------------------
# 3. This environment's secrets. They live in the deployment platform, never
#    in the images and never in the manifest, which is what lets the same
#    bytes serve staging and production.
# ---------------------------------------------------------------------------
echo "deploy: 3/12 deployment secrets"
if [ -z "${ENVIRONMENT_FILE:-}" ]; then
  echo "deploy: ENVIRONMENT_FILE must point at this environment's secrets" >&2
  exit 78
fi

env_file=$(mktemp)
chmod 600 "$env_file"
trap 'rm -f "$env_file"' EXIT
cat "$ENVIRONMENT_FILE" > "$env_file"
cat "$IMAGES_ENV" >> "$env_file"

node "$HERE/check-deployment-secrets.mjs" --env-file "$env_file" --compose "$COMPOSE"

compose() { docker compose -p "$PROJECT" --env-file "$env_file" "${compose_files[@]}" "$@"; }

# ---------------------------------------------------------------------------
# 4. Migration compatibility, before a container starts.
#
#    This asks whether the migrations this release carries are a superset of
#    what the database already has. It is the difference between "there is
#    work to do" and "this database was migrated by a release this one has
#    never heard of", and the second is not something to discover halfway
#    through a rollout.
# ---------------------------------------------------------------------------
echo "deploy: 4/12 migration compatibility preflight"
# Only the long-running services are waited on. `certs` and `storage-init` are
# one-shot jobs that exit 0 when they are done, and `--wait` treats a listed
# service exiting as a failure — so naming them here fails the deployment for
# doing exactly what they are supposed to do. They still run, pulled in by the
# `service_completed_successfully` conditions the topology already declares.
compose up -d --wait --wait-timeout "$INFRA_WAIT" postgres redis minio clamav
compose up --exit-code-from storage-init storage-init

# Before the migrate job, not after. `migrate-check` in the topology depends on
# `migrate` having completed, so running it here would apply the migrations
# this step exists to decide about.
# The same URL the topology gives the migrate job: the `palcert` role, which
# owns the schema. Built here rather than read from the environment file
# because the file holds the password, not the URL — the URL is assembled by
# the topology, and duplicating it in the secrets would be a second place for
# it to drift.
admin_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file" | head -1)
if [ -z "$admin_password" ]; then
  echo "deploy: POSTGRES_PASSWORD is not set; cannot run the migration preflight" >&2
  exit 78
fi
NETWORK="${PROJECT}_internal" \
DATABASE_ADMIN_URL="postgresql://palcert:${admin_password}@postgres:5432/palcert" \
PREFLIGHT_IMAGE="$(sed -n 's/^API_IMAGE=//p' "$IMAGES_ENV" | head -1)" \
  bash "$HERE/migration-preflight.sh"
unset admin_password

# ---------------------------------------------------------------------------
# 5. The frozen set. Last gate before anything of this release runs.
# ---------------------------------------------------------------------------
if [ -n "${FREEZE:-}" ]; then
  echo "deploy: 5/12 frozen release set"
  node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE" --images-env "$IMAGES_ENV"
else
  echo "deploy: 5/12 frozen release set (no FREEZE given — deploying from the manifest alone)"
fi

# ---------------------------------------------------------------------------
# 6-7. Internal services are already up from step 4; the migration job runs
#      once, as its own image, with schema authority no other container has.
# ---------------------------------------------------------------------------
echo "deploy: 6/12 internal services"
# clamav among them: the worker refuses readiness while the malware scanner is
# unreachable, and it is right to. Every uploaded document is scanned before
# anything else touches it, so a worker that is "ready" without a scanner
# would either process documents unscanned or fail every job. Starting it here
# rather than alongside the worker also gives its signature database time to
# load, which is why this step waits longer than the others.
compose up -d --wait --wait-timeout "$INFRA_WAIT" postgres redis minio clamav

echo "deploy: 7/12 migrations"
compose up --exit-code-from migrate migrate

# ---------------------------------------------------------------------------
# 8. `migrate` exiting 0 says the job ran, not that this database is now at
#    this build's level. Checkpoint 20.3 shipped exactly that difference.
# ---------------------------------------------------------------------------
echo "deploy: 8/12 migration state"
compose up --exit-code-from migrate-check migrate-check

status=$(compose run --rm --no-deps -T migrate \
  node_modules/.bin/prisma migrate status --schema prisma/schema.prisma 2>&1 || true)
if ! echo "$status" | grep -q "Database schema is up to date"; then
  echo "deploy: the database is not at the schema this release expects ($expected_head)" >&2
  echo "$status" | tail -5 >&2
  exit 65
fi
echo "deploy:   database is at $expected_head"

# ---------------------------------------------------------------------------
# 9-11. Application, then readiness, then the worker.
#
#       The worker starts after the API is ready on purpose. It consumes the
#       same database and object storage, and starting it against a stack that
#       has not proved itself means jobs begin executing inside a deployment
#       that may be about to be abandoned.
# ---------------------------------------------------------------------------
echo "deploy: 9/12 application services"
compose up -d --wait --wait-timeout "$APP_WAIT" document-engine api web

echo "deploy: 10/12 readiness and release identity"
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_OVERRIDE="$COMPOSE_OVERRIDE" \
  bash "$HERE/verify-release-identity.sh" "$MANIFEST" "$env_file" "$COMPOSE" --without-worker

echo "deploy: 11/12 worker"
compose up -d --wait --wait-timeout "$APP_WAIT" worker
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_OVERRIDE="$COMPOSE_OVERRIDE" \
  bash "$HERE/verify-release-identity.sh" "$MANIFEST" "$env_file" "$COMPOSE"

if [ -n "${FREEZE:-}" ]; then
  # The no-rebuild proof, asked of the containers that exist rather than of
  # the configuration that asked for them.
  node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE" --running --project "$PROJECT"
fi

# ---------------------------------------------------------------------------
# 12. Smoke, then ingress. In that order, and ingress only if smoke passed.
# ---------------------------------------------------------------------------
echo "deploy: 12/12 smoke and ingress"
if [ -z "$SMOKE" ]; then
  echo "deploy: no SMOKE suite given — refusing to open ingress unverified" >&2
  exit 78
fi
COMPOSE_PROJECT_NAME="$PROJECT" ENV_FILE="$env_file" COMPOSE_FILE="$COMPOSE" \
  COMPOSE_OVERRIDE="$COMPOSE_OVERRIDE" bash "$SMOKE"

compose up -d --wait --wait-timeout 180 proxy

echo "deploy: $release is serving in $DEPLOY_ENVIRONMENT"
