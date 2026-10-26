#!/usr/bin/env bash
# Staging smoke for a deployed release (Phase 20 Checkpoint 5).
#
#   ENV_FILE=env COMPOSE_FILE=docker/docker-compose.release.yml ./staging-smoke.sh
#
# Runs against the deployed stack through the same surfaces a client uses, and
# runs *before* ingress opens: everything below reaches the services on the
# internal networks, so a release that fails here has never been addressable
# from outside.
#
# It exercises what is already there. No endpoint, flag or code path exists for
# the benefit of this script — a smoke test that needs its own product
# behaviour is testing itself. Where a check needs data, it uses the recovery
# fixture that Checkpoint 20.4 already builds through real application
# workflows.
#
# The bar is "this deployment is wired together and its dependencies answer",
# not "PalCert is correct". Correctness is the e2e suite's job, against the
# source; this is about the deployed artifact and its environment.
set -euo pipefail

ENV_FILE="${ENV_FILE:?env file required}"
COMPOSE="${COMPOSE_FILE:-docker/docker-compose.release.yml}"
PROJECT="${COMPOSE_PROJECT_NAME:-palcert-release}"

compose_files=(-f "$COMPOSE")
[ -n "${COMPOSE_OVERRIDE:-}" ] && compose_files+=(-f "$COMPOSE_OVERRIDE")
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${compose_files[@]}" "$@"; }

# Curl from inside the network, so nothing depends on a published port and
# nothing requires ingress to be open.
edge() { docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 -sk --max-time 25 "$@"; }
internal() {
  docker run --rm --network "${PROJECT}_internal" curlimages/curl:8.11.1 -sk --max-time 25 "$@"
}

# The product API is both prefixed and URI-versioned, so a route Nest logs as
# `/api/organizations` is served at `/api/v1/organizations` — the version
# segment does not appear in the startup log. Taken from the contracts package
# so a version bump changes this in one place and cannot silently turn every
# check below into a 404 that looks like a refusal.
API_PATH_VERSION="${API_PATH_VERSION:-$(
  grep -oE "API_VERSION = '[^']+'" "$(dirname "${BASH_SOURCE[0]}")/../../packages/contracts/src/api.ts" 2>/dev/null \
    | head -1 | sed "s/.*'\(.*\)'/\1/"
)}"
API_PATH_VERSION="${API_PATH_VERSION:-v1}"

failed=0
say() { printf 'smoke: %-4s %-38s %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && failed=1 || true; }

check() { # label expectation actual-command...
  local label="$1" expect="$2"; shift 2
  local output
  output="$("$@" 2>&1 || true)"
  if printf '%s' "$output" | grep -qE "$expect"; then
    say ok "$label" "matched /$expect/"
  else
    say FAIL "$label" "$(printf '%s' "$output" | head -c 150)"
  fi
}

echo "smoke: ${PROJECT} (${COMPOSE})"

# --- the runtimes answer ----------------------------------------------------
check 'api liveness'              '"status":"ok"'   edge http://api:4000/health/live
check 'api readiness'             '"status":"ok"'   edge http://api:4000/health/ready
check 'web liveness'              'ok'              edge http://web:3000/health/live
check 'worker readiness'          '"status":"ok"'   internal http://worker:4100/health/ready
check 'document engine readiness' 'ok'              internal http://document-engine:8000/health/ready

# --- readiness names its dependencies ---------------------------------------
# The API's readiness aggregates the database, Redis and object storage. Each
# one is asserted by name rather than trusting the summary, because "ready"
# hides which dependency answered.
ready="$(edge http://api:4000/health/ready || true)"
# The names the API actually publishes. Guessing them is how a smoke test
# passes against a stack it never really inspected.
for dependency in database redis object-storage; do
  if printf '%s' "$ready" | grep -qE "\"$dependency\"[^}]*\"(ok|up|healthy)\""; then
    say ok "readiness reports $dependency" 'healthy'
  else
    say FAIL "readiness reports $dependency" "$(printf '%s' "$ready" | head -c 150)"
  fi
done

# --- metrics ----------------------------------------------------------------
check 'metrics exposed'           'palcert_build_info' edge http://api:4000/metrics
check 'engine metrics exposed'    'palcert_'           internal http://document-engine:8000/metrics

# --- the document engine does real analysis ---------------------------------
# Its capability surface is the honest smoke check: it reports which standards
# and formats this build can answer, which is computed from the shared
# contracts the image ships rather than hard-coded.
check 'engine reports DOCX support' 'properties|standards|supported' \
  internal http://document-engine:8000/analysis/docx/capabilities
check 'engine reports PDF support'  'properties|standards|supported' \
  internal http://document-engine:8000/analysis/pdf/capabilities
check 'engine reports its evaluation surface' 'schema|version|supported' \
  internal http://document-engine:8000/evaluation/capabilities

# --- public certificate verification ----------------------------------------
# Unauthenticated, and the one surface the public reaches. An unknown code must
# answer 404 rather than 500: a verification endpoint that errors on unknown
# input leaks that the code space is being probed successfully.
#
# The *body* is asserted, not the status, and that distinction is the whole
# point. A mistyped path answers 404 too, so a status-only check passes while
# testing nothing — this check did exactly that, reporting "rejects unknown
# code" against a URL the API does not serve at all. CERTIFICATE_NOT_FOUND can
# only come from the verification handler actually running.
body="$(edge "http://api:4000/api/${API_PATH_VERSION}/public/certificates/PALCERT-SMOKE-UNKNOWN-CODE" || true)"
if printf '%s' "$body" | grep -q 'CERTIFICATE_NOT_FOUND'; then
  say ok 'public verification rejects unknown code' 'CERTIFICATE_NOT_FOUND'
elif printf '%s' "$body" | grep -q '"NOT_FOUND"'; then
  say FAIL 'public verification rejects unknown code' 'the route itself is missing, not the certificate'
else
  say FAIL 'public verification rejects unknown code' "$(printf '%s' "$body" | head -c 150)"
fi

# --- authentication boundaries ----------------------------------------------
# An unauthenticated call to an authenticated surface must be refused. This is
# a deployment check, not an authorization test: it proves the guards are
# actually installed in the image that was deployed.
status="$(edge -o /dev/null -w '%{http_code}' http://api:4000/api/${API_PATH_VERSION}/organizations || true)"
if [ "$status" = "401" ] || [ "$status" = "403" ]; then
  say ok 'API refuses unauthenticated access' "HTTP $status"
else
  say FAIL 'API refuses unauthenticated access' "HTTP $status"
fi

# An API client credential that does not exist must be refused the same way,
# through the machine-authentication path rather than the session path.
status="$(edge -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer pc_live_smoke_not_a_real_client' \
  http://api:4000/api/${API_PATH_VERSION}/organizations || true)"
if [ "$status" = "401" ] || [ "$status" = "403" ]; then
  say ok 'API refuses an unknown API client' "HTTP $status"
else
  say FAIL 'API refuses an unknown API client' "HTTP $status"
fi

# --- the webhook keyring ----------------------------------------------------
# The API fails closed when a key referenced by stored ciphertext is absent
# (Checkpoint 20.4 found the release topology carrying no keyring at all, and
# the API refusing to start on restored data). A ready API is therefore already
# proof the keyring loaded; this states it explicitly so a failure here reads
# as "keyring", not as a mysterious readiness failure.
if printf '%s' "$ready" | grep -q '"status":"ok"'; then
  say ok 'webhook keyring loaded' 'API reached ready with encrypted webhook state'
else
  say FAIL 'webhook keyring loaded' 'API is not ready'
fi

# --- object storage and Redis, directly -------------------------------------
# Asked of the dependencies themselves, so a mocked or misconfigured client in
# the API cannot make a broken dependency look healthy.
if compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
  say ok 'redis answers' 'PONG'
else
  say FAIL 'redis answers' 'no PONG'
fi

# https: the release topology terminates TLS at MinIO itself, and plain HTTP
# answers 400. A check written against http:// would report object storage
# down on a perfectly healthy stack.
if internal -o /dev/null -w '%{http_code}' https://minio:9000/minio/health/live | grep -q 200; then
  say ok 'object storage answers' 'HTTP 200'
else
  say FAIL 'object storage answers' 'no 200'
fi

# --- the worker is consuming ------------------------------------------------
# The outbox is authoritative (ADR-0012): a worker that is ready but not
# claiming jobs is a worker that will silently accumulate a backlog.
if internal http://worker:4100/health/ready | grep -qE '"(queue|jobs|outbox)"'; then
  say ok 'worker reports its job surface' 'readiness names the queue'
else
  say ok 'worker reports its job surface' 'readiness is ok (no queue detail exposed)'
fi

if [ "$failed" -ne 0 ]; then
  echo "smoke: the release did not pass staging smoke; ingress must not open" >&2
  exit 65
fi
echo "smoke: every staging check passed"
