#!/usr/bin/env bash
# Prove an unhealthy release candidate never reaches external ingress
# (Phase 20 Checkpoint 5).
#
#   FREEZE=release-freeze.json SECRETS=secrets.env \
#     bash scripts/release/test-failed-promotions.sh
#
# Twelve ways a promotion goes wrong, each induced for real and each ending
# with the same assertion: the deployment exited non-zero, and no proxy is
# serving. That second half is the one that matters. A deployment that fails
# loudly and still opens ingress has failed in the only way that reaches
# users, and the difference between the two is invisible in a workflow log
# that ends in a red cross either way.
#
# The cases are ordered by how far they get. The early ones cost nothing
# because they are refused before a container starts — which is the point of
# putting the manifest, registry, secret and schema checks first. The later
# ones have to build most of a stack before they can fail, and are the reason
# this suite is slow.
#
# Nothing here weakens a gate to make a case reproduce. Each one breaks an
# input the way it would break in practice: a digest that was
# garbage-collected, a manifest edited in transit, a secret that was never
# added to the new environment, a database migrated by a later release.
set -euo pipefail

FREEZE="${FREEZE:?release freeze record required}"
SECRETS="${SECRETS:?environment secrets file required}"
PROJECT="${FAILURE_PROJECT:-palcert-failtest}"
WORK="${FAILURE_WORK:-$(mktemp -d)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMPOSE="${COMPOSE_FILE:-docker/docker-compose.release.yml}"
MANIFEST="$(python3 -c "import json,os,sys; f=sys.argv[1]; print(os.path.join(os.path.dirname(f), json.load(open(f))['manifest']['file']))" "$FREEZE")"

mkdir -p "$WORK"
failures=0

teardown() {
  docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$SECRETS" \
    down -v --remove-orphans > /dev/null 2>&1 || true
}

# The assertion every case shares. "Refused" is not enough on its own: the
# question is whether anything outside could have reached this candidate.
ingress_is_closed() {
  local running
  running=$(docker ps --filter "name=${PROJECT}-proxy" --filter status=running --quiet | wc -l)
  [ "$running" -eq 0 ]
}

case_result() { # label expected-to-fail-at
  local label="$1" stage="$2" status="$3"
  if [ "$status" -eq 0 ]; then
    echo "  FAIL $label: the deployment SUCCEEDED — it should have been refused" >&2
    failures=$((failures + 1))
  elif ! ingress_is_closed; then
    echo "  FAIL $label: refused (exit $status) but a proxy is serving the candidate" >&2
    failures=$((failures + 1))
  else
    echo "  ok   $label: refused at $stage (exit $status), ingress never opened"
  fi
}

run_deploy() { # manifest images-env secrets [extra env assignments...]
  local manifest="$1" images="$2" secrets="$3"; shift 3
  local status=0
  # The caller's assignments come last so they win. They used to come first,
  # which meant a case supplying its own SMOKE had it silently replaced by the
  # default on the next line — and the case that was supposed to fail smoke
  # ran the real suite and passed.
  env \
    FREEZE="$FREEZE" \
    ENVIRONMENT_FILE="$secrets" \
    COMPOSE_PROJECT_NAME="$PROJECT" \
    DEPLOY_ENVIRONMENT="failure-rehearsal" \
    INSECURE_REGISTRY="${INSECURE_REGISTRY:-}" \
    SMOKE="$HERE/staging-smoke.sh" \
    DEPLOY_WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-90}" \
    "$@" \
    bash "$HERE/deploy.sh" "$manifest" "$images" > "$WORK/last.log" 2>&1 || status=$?
  echo "$status"
}

node "$HERE/render-deploy-env.mjs" --manifest "$MANIFEST" --out "$WORK/good.env" > /dev/null

echo "test-failed-promotions: $(python3 -c "import json;print(json.load(open('$FREEZE'))['releaseVersion'])")"
teardown

# --- 1. an image digest that is not in the registry -------------------------
# What a garbage-collected rollback image looks like. The manifest is
# internally valid; the bytes are simply gone.
python3 - "$MANIFEST" "$WORK/unknown-digest.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest['images']['api']['digest'] = 'sha256:' + 'ab' * 32
json.dump(manifest, open(sys.argv[2], 'w'), indent=2, sort_keys=True)
with open(sys.argv[2], 'a') as handle:
    handle.write('\n')
PY
node "$HERE/render-deploy-env.mjs" --manifest "$WORK/unknown-digest.json" \
  --out "$WORK/unknown-digest.env" > /dev/null
case_result 'an image digest absent from the registry' 'registry verification' \
  "$(run_deploy "$WORK/unknown-digest.json" "$WORK/unknown-digest.env" "$SECRETS")"

# --- 2. the manifest commit disagrees with the images -----------------------
# The case that motivated reading org.opencontainers.image.revision back from
# the registry: every field agrees with every other field, and only the images
# know the manifest is wrong.
python3 - "$MANIFEST" "$WORK/wrong-commit.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest['commit'] = 'f' * 40
json.dump(manifest, open(sys.argv[2], 'w'), indent=2, sort_keys=True)
with open(sys.argv[2], 'a') as handle:
    handle.write('\n')
PY
case_result 'a manifest whose commit the images contradict' 'registry verification' \
  "$(run_deploy "$WORK/wrong-commit.json" "$WORK/good.env" "$SECRETS")"

# --- 3. a manifest modified in transit --------------------------------------
sed 's/"manifestVersion": 1/"manifestVersion": 99/' "$MANIFEST" > "$WORK/corrupt.json"
case_result 'a corrupted manifest' 'manifest validation' \
  "$(run_deploy "$WORK/corrupt.json" "$WORK/good.env" "$SECRETS")"

# --- 4. a deployment secret this environment never had ----------------------
grep -v '^AUTH_MFA_SECRET_KEY=' "$SECRETS" > "$WORK/no-mfa-key.env"
case_result 'a missing deployment secret' 'the secrets preflight' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$WORK/no-mfa-key.env")"

# --- 5. the webhook keyring absent ------------------------------------------
# Its own case rather than a variation of the one above, because Checkpoint
# 20.4 found the release topology carrying no keyring at all and the API
# failing closed on restored data. That must be caught before anything starts.
grep -v '^WEBHOOK_ENCRYPTION_KEYS=' "$SECRETS" > "$WORK/no-keyring.env"
case_result 'a missing webhook keyring' 'the secrets preflight' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$WORK/no-keyring.env")"

# --- 6. provenance missing --------------------------------------------------
# Verified against a predicate type no image carries, which is what an image
# published without provenance looks like to this check.
case_result 'an image with no usable provenance' 'provenance verification' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$SECRETS" \
      PROVENANCE_PREDICATE=https://example.invalid/provenance/v99)"

# --- 7. the database is ahead of this release -------------------------------
# A database migrated by a later release. The older release would connect,
# answer readiness, and fail only on the paths that touch what it does not
# know about — so the preflight refuses before anything serves.
#
# The release is deployed properly first, and only then is a later release's
# migration recorded. Seeding the marker into an empty database instead makes
# every real migration merely *pending*, which is the ordinary "behind" case
# and is correctly allowed — this case passed for that reason until the
# deployment succeeded and gave it away.
teardown
cat "$SECRETS" "$WORK/good.env" > "$WORK/combined.env"
if [ "$(run_deploy "$MANIFEST" "$WORK/good.env" "$SECRETS")" != "0" ]; then
  echo "  FAIL a database migrated by a later release: could not establish the baseline" >&2
  sed 's/^/        /' "$WORK/last.log" | tail -20 >&2
  failures=$((failures + 1))
fi
docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$WORK/combined.env" \
  exec -T postgres \
  psql -U palcert -d palcert -v ON_ERROR_STOP=1 -c "
    INSERT INTO _prisma_migrations
      (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
    VALUES ('fixture-future', 'fixture', now(), '29990101000000_from_a_later_release', now(), 1)
    ON CONFLICT DO NOTHING;" > "$WORK/pg-seed.log" 2>&1 || {
    echo "  FAIL a database migrated by a later release: could not seed the history" >&2
    sed 's/^/        /' "$WORK/pg-seed.log" >&2
    failures=$((failures + 1))
  }
# Ingress is open from the baseline deployment, so it is closed again before
# the case runs: otherwise "ingress never opened" would be testing the
# previous deployment rather than this one.
docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$WORK/combined.env" \
  stop proxy > /dev/null 2>&1 || true
docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$WORK/combined.env" \
  rm -f proxy > /dev/null 2>&1 || true
case_result 'a database migrated by a later release' 'the migration preflight' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$SECRETS")"
teardown

# --- 8. the migration job itself fails --------------------------------------
# An object already present that the first migration will try to create. That
# is what a partially-restored database, or a hand-edited schema, does to a
# migration job — and it must stop the deployment rather than roll out an
# application against whatever schema happens to be there.
#
# Changing POSTGRES_APP_PASSWORD was tried first and proves nothing: the
# database is initialised from that same variable, so both sides simply agree
# on the new password and everything works.
teardown
cat "$SECRETS" "$WORK/good.env" > "$WORK/combined.env"
docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$WORK/combined.env" \
  up -d --wait --wait-timeout 300 postgres > "$WORK/pg-up.log" 2>&1 || true
docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$WORK/combined.env" \
  exec -T postgres psql -U palcert -d palcert -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE organizations (id uuid PRIMARY KEY);' > "$WORK/pg-conflict.log" 2>&1 || {
    echo "  FAIL a migration that cannot apply: could not create the conflicting object" >&2
    sed 's/^/        /' "$WORK/pg-conflict.log" >&2
    failures=$((failures + 1))
  }
case_result 'a migration that cannot apply' 'the migration job' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$SECRETS")"
teardown

# --- 9. the API never becomes ready -----------------------------------------
# Configuration the API rejects at startup. It exits non-zero before it can
# serve, so the rollout never reaches readiness.
#
# Breaking the storage credentials was tried first and, like the database
# password, proves nothing: MinIO is initialised from the same variable.
sed 's/^AUTH_MFA_SECRET_KEY=.*/AUTH_MFA_SECRET_KEY=too-short/' "$SECRETS" \
  > "$WORK/bad-mfa-key.env"
case_result 'an API that never becomes ready' 'application readiness' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$WORK/bad-mfa-key.env")"
teardown

# --- 10. the worker never becomes ready -------------------------------------
# The malware scanner unreachable. The worker refuses readiness rather than
# processing documents unscanned, and the deployment must respect that refusal
# instead of opening ingress on a stack that cannot accept an upload.
sed 's/^MALWARE_SCANNER=.*/MALWARE_SCANNER=clamav-that-does-not-exist/' "$SECRETS" \
  > "$WORK/no-scanner.env"
case_result 'a worker that never becomes ready' 'worker readiness' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$WORK/no-scanner.env")"
teardown

# --- 11. the document engine is unavailable ---------------------------------
# The one case here that cannot be produced from an input: the engine takes no
# environment this deployment supplies. It stands for the engine dying during
# a rollout, and it is induced by stopping the container whenever it appears,
# for the duration of the deployment.
#
# A single `sleep 100; docker stop` was tried first and passed the deployment,
# because by then the rollout was already past the point where it mattered.
# Polling makes it deterministic rather than a race the test usually loses.
teardown
(
  for _ in $(seq 1 400); do
    docker stop "${PROJECT}-document-engine-1" > /dev/null 2>&1 || true
    sleep 1
  done
) &
stopper=$!
case_result 'the document engine unavailable' 'readiness' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$SECRETS")"
kill "$stopper" 2> /dev/null || true
wait "$stopper" 2> /dev/null || true
teardown

# --- 12. staging smoke fails ------------------------------------------------
# Everything healthy, every digest right, and the smoke suite says no. Ingress
# must still not open — this is the last gate before it does.
cat > "$WORK/failing-smoke.sh" <<'SMOKE'
#!/usr/bin/env bash
echo "smoke: a representative check failed"
exit 65
SMOKE
chmod +x "$WORK/failing-smoke.sh"
case_result 'a release that fails staging smoke' 'smoke, before ingress' \
  "$(run_deploy "$MANIFEST" "$WORK/good.env" "$SECRETS" SMOKE="$WORK/failing-smoke.sh")"
teardown

if [ "$failures" -ne 0 ]; then
  echo "test-failed-promotions: $failures case(s) failed; logs in $WORK" >&2
  exit 65
fi
echo "test-failed-promotions: every unhealthy candidate refused, and none reached ingress"
