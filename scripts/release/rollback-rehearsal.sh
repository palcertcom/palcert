#!/usr/bin/env bash
# Release A -> Release B -> Release A, with real digests
# (Phase 20 Checkpoint 5).
#
#   FREEZE_A=... FREEZE_B=... SECRETS=... bash scripts/release/rollback-rehearsal.sh
#
# A rollback plan that has never been executed is a document, not a plan. The
# parts that fail in practice are never the ones the document worries about:
# the images have been garbage-collected, the manifest cannot be found, the
# older release will not start against the schema the newer one migrated, or
# the thing that comes back up cannot be proved to be the thing that was
# asked for.
#
# So this deploys a real prior release, upgrades to the current one over the
# same database, rolls back to the prior one, and at every step asks the
# running system which release it is rather than trusting the command that
# was issued. Nothing is rebuilt: both releases are deployed from digests
# recorded in their freeze records, and Release A's images are the bytes
# built weeks before Release B existed.
#
# The database is deliberately *not* rolled back. Step 5 runs the safety gate
# that decides whether that is survivable, and PalCert will not generate
# reverse migrations to pretend otherwise.
set -euo pipefail

FREEZE_A="${FREEZE_A:?the prior release freeze record is required}"
FREEZE_B="${FREEZE_B:?the current release freeze record is required}"
SECRETS="${SECRETS:?the environment secrets file is required}"
PROJECT="${ROLLBACK_PROJECT:-palcert-rollback}"
WORK="${ROLLBACK_WORK:-$(mktemp -d)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMPOSE="${COMPOSE_FILE:-docker/docker-compose.release.yml}"

mkdir -p "$WORK"

manifest_of() { # freeze -> its manifest path, which sits beside it
  python3 -c "import json,os,sys; f=sys.argv[1]; print(os.path.join(os.path.dirname(f), json.load(open(f))['manifest']['file']))" "$1"
}
version_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['releaseVersion'])" "$1"; }
commit_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['commit'])" "$1"; }

MANIFEST_A="$(manifest_of "$FREEZE_A")"
MANIFEST_B="$(manifest_of "$FREEZE_B")"
VERSION_A="$(version_of "$FREEZE_A")"
VERSION_B="$(version_of "$FREEZE_B")"

echo "rollback-rehearsal: A=$VERSION_A  B=$VERSION_B  project=$PROJECT"

failed=0
say() { printf 'rollback-rehearsal: %-4s %s\n' "$1" "$2"; [ "$1" = FAIL ] && failed=1 || true; }

deploy() { # freeze manifest label
  local freeze="$1" manifest="$2" label="$3"
  node "$HERE/render-deploy-env.mjs" --manifest "$manifest" --out "$WORK/$label.env" > /dev/null
  FREEZE="$freeze" \
  ENVIRONMENT_FILE="$SECRETS" \
  COMPOSE_PROJECT_NAME="$PROJECT" \
  DEPLOY_ENVIRONMENT="rollback-rehearsal" \
  INSECURE_REGISTRY="${INSECURE_REGISTRY:-}" \
  SMOKE="${SMOKE:-$HERE/staging-smoke.sh}" \
  bash "$HERE/deploy.sh" "$manifest" "$WORK/$label.env" > "$WORK/$label.log" 2>&1
}

# The question is always asked of the running system, never of the deployment
# that was requested. `/health/ready` reports the commit the process was built
# from, and the container records the digest it was created from; a rollback
# is only trustworthy if both can be compared against what was asked for.
identity() { # expected-commit label
  local expected="$1" label="$2"
  local reported
  reported=$(docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
    -sk http://api:4000/health/ready 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['release']['commit'])" 2>/dev/null || echo '(unreadable)')
  if [ "$reported" = "$expected" ]; then
    say ok "$label: the API reports ${expected:0:12}"
  else
    say FAIL "$label: the API reports $reported, expected ${expected:0:12}"
  fi
}

# ---------------------------------------------------------------------------
# 1. Release A, into a clean environment.
# ---------------------------------------------------------------------------
echo "rollback-rehearsal: 1/7 deploying $VERSION_A"
docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$SECRETS" down -v --remove-orphans \
  > /dev/null 2>&1 || true
if deploy "$FREEZE_A" "$MANIFEST_A" a-first; then
  say ok "$VERSION_A deployed"
else
  say FAIL "$VERSION_A failed to deploy"; tail -25 "$WORK/a-first.log" >&2; exit 65
fi

echo "rollback-rehearsal: 2/7 verifying $VERSION_A"
identity "$(commit_of "$FREEZE_A")" "$VERSION_A"
node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE_A" --running --project "$PROJECT" \
  > /dev/null && say ok "$VERSION_A runs its own frozen digests" \
  || say FAIL "$VERSION_A is not running its frozen digests"

# ---------------------------------------------------------------------------
# 3. Release B, over the same database. This is an upgrade, not a fresh
#    install: the schema, the object storage and the data all persist.
# ---------------------------------------------------------------------------
echo "rollback-rehearsal: 3/7 deploying $VERSION_B over it"
if deploy "$FREEZE_B" "$MANIFEST_B" b; then
  say ok "$VERSION_B deployed over $VERSION_A"
else
  say FAIL "$VERSION_B failed to deploy"; tail -25 "$WORK/b.log" >&2; exit 65
fi

echo "rollback-rehearsal: 4/7 verifying $VERSION_B"
identity "$(commit_of "$FREEZE_B")" "$VERSION_B"
node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE_B" --running --project "$PROJECT" \
  > /dev/null && say ok "$VERSION_B runs its own frozen digests" \
  || say FAIL "$VERSION_B is not running its frozen digests"

# ---------------------------------------------------------------------------
# 5. The decision. Not "can these images start" but "can A run against the
#    schema B left behind".
# ---------------------------------------------------------------------------
echo "rollback-rehearsal: 5/7 rollback safety, $VERSION_B -> $VERSION_A"
safety=0
node "$HERE/check-rollback-safety.mjs" --from "$MANIFEST_B" --to "$MANIFEST_A" \
  > "$WORK/safety.txt" 2>&1 || safety=$?
sed 's/^/rollback-rehearsal:   /' "$WORK/safety.txt"
if [ "$safety" -ne 0 ]; then
  # Not a failure of the rehearsal — it is the gate doing its job. But the
  # rollback stops here, because that is the whole point of asking.
  say ok "the gate refused the rollback (exit $safety); leaving $VERSION_B running"
  echo "rollback-rehearsal: stopping: an application rollback would run $VERSION_A against a schema it does not know"
  exit 0
fi
say ok "both releases expect the same schema — application rollback only"

# ---------------------------------------------------------------------------
# 6-7. Back to A, on its original digests. Nothing is rebuilt and no image is
#      retagged: these are the same bytes deployed in step 1.
# ---------------------------------------------------------------------------
echo "rollback-rehearsal: 6/7 rolling back to $VERSION_A"
if deploy "$FREEZE_A" "$MANIFEST_A" a-rollback; then
  say ok "$VERSION_A redeployed from its retained digests"
else
  say FAIL "the rollback to $VERSION_A failed"; tail -25 "$WORK/a-rollback.log" >&2; exit 65
fi

echo "rollback-rehearsal: 7/7 verifying $VERSION_A is serving again"
identity "$(commit_of "$FREEZE_A")" "$VERSION_A after rollback"
node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE_A" --running --project "$PROJECT" \
  > /dev/null && say ok "$VERSION_A runs its frozen digests after rollback" \
  || say FAIL "the rolled-back stack is not running $VERSION_A's digests"

# The smoke suite ran inside the deployment before ingress opened; running it
# again afterwards is the post-rollback health check an operator would do.
if ENV_FILE="$WORK/a-rollback.env.full" COMPOSE_PROJECT_NAME="$PROJECT" \
   bash -c "cat '$SECRETS' '$WORK/a-rollback.env' > '$WORK/a-rollback.env.full'; \
            ENV_FILE='$WORK/a-rollback.env.full' COMPOSE_PROJECT_NAME='$PROJECT' \
            bash '$HERE/staging-smoke.sh'" > "$WORK/post-rollback-smoke.log" 2>&1; then
  say ok 'post-rollback smoke passed'
else
  say FAIL 'post-rollback smoke failed'
  tail -25 "$WORK/post-rollback-smoke.log" >&2
fi

if [ "$failed" -ne 0 ]; then
  echo "rollback-rehearsal: the rehearsal did not hold; logs in $WORK" >&2
  exit 65
fi
echo "rollback-rehearsal: $VERSION_A -> $VERSION_B -> $VERSION_A, verified at every step"
echo "rollback-rehearsal: logs in $WORK"
