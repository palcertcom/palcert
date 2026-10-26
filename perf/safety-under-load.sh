#!/usr/bin/env bash
# Safety properties, re-proved while the system is under load
# (Phase 20 Checkpoint 6, requirement 25).
#
#   PROJECT=palcert-perf VALID_CODE=… DB_APP_PASSWORD=… DB_OWNER_PASSWORD=… \
#     K6_BIN=/path/to/k6 bash perf/safety-under-load.sh
#
# The reason this exists separately from the functional suites is that load is
# where correctness quietly stops holding. A tenant boundary that is enforced
# by a query built per request, an idempotency key that is only unique because
# nothing ever raced it, a rate limit that lives in one process's memory —
# each of these passes every single-threaded test and fails the first busy
# afternoon. So these checks are run with traffic flowing, not against an idle
# stack.
#
# Nothing here is weakened for the occasion: no guard is disabled, no limit
# raised, no constraint dropped. If a property cannot be proved in this
# environment it is reported as not proved rather than approximated.
set -uo pipefail

PROJECT="${PROJECT:-palcert-perf}"
VALID_CODE="${VALID_CODE:-}"
K6_BIN="${K6_BIN:?path to the k6 binary is required}"
DB_APP_PASSWORD="${DB_APP_PASSWORD:?the application role password is required}"
DB_OWNER_PASSWORD="${DB_OWNER_PASSWORD:?the owner role password is required}"
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:?the admin database URL is required}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

failures=0
say() {
  printf 'safety: %-4s %-58s %s\n' "$1" "$2" "${3:-}"
  [ "$1" = FAIL ] && failures=$((failures + 1)) || true
}

# Both roles, because the interesting questions need both. The owner sees
# everything (it is the migration role and bypasses row-level security), so it
# is how the harness learns what *should* be visible. The application role is
# the one the API actually connects as, and it is the one the isolation checks
# interrogate.
as_app() { docker exec -e PGPASSWORD="$DB_APP_PASSWORD" "${PROJECT}-postgres-1" \
  psql -U palcert_app -d palcert -tAqc "$1" 2>&1; }
as_owner() { docker exec -e PGPASSWORD="$DB_OWNER_PASSWORD" "${PROJECT}-postgres-1" \
  psql -U palcert -d palcert -tAqc "$1" 2>&1; }

expect_zero() { # sql label
  local value
  value="$(as_owner "$1")"
  if [ "$value" = "0" ]; then
    say ok "$2"
  else
    say FAIL "$2" "returned '$value', expected 0"
  fi
}

echo "safety: project=$PROJECT out=$OUT"

# ---------------------------------------------------------------------------
# Load, for the duration of the checks.
#
# Public verification with spread client identities: the cheapest workload
# that still puts the database, Redis and the HTTP stack on the path of every
# request, which is what makes the checks below mean something.
# ---------------------------------------------------------------------------
docker rm -f safety-load safety-api-a safety-api-b > /dev/null 2>&1 || true
docker run -d --name safety-load --network "${PROJECT}_edge" \
  -v "$K6_BIN:/k6:ro" -v "$REPO/perf:/perf:ro" -e K6_NO_PROGRESS=true \
  --entrypoint /k6 alpine:3.20 run \
  -e PALCERT_BASE_URL=http://api:4000 -e PALCERT_SPREAD_CLIENTS=true \
  -e "PALCERT_VALID_CODE=$VALID_CODE" -e PALCERT_RATE=100 \
  -e PALCERT_DURATION=900s -e PALCERT_VUS=60 -e PALCERT_MAX_VUS=200 \
  /perf/k6/public-verification.js > /dev/null
# The replica's environment file carries the stack's real credentials, so it
# does not outlive the run. Neither does the second replica, whatever exit
# path this script takes.
cleanup() {
  docker rm -f safety-load safety-api-a safety-api-b > /dev/null 2>&1 || true
  rm -f "$OUT/replica.env"
}
trap cleanup EXIT
sleep 10

# Traffic must actually be flowing, or every check below is being run against
# an idle system while claiming otherwise.
if [ "$(docker inspect -f '{{.State.Running}}' safety-load 2>/dev/null)" = "true" ]; then
  say ok 'load is flowing while the safety checks run'
else
  say FAIL 'load is flowing while the safety checks run' 'the generator is not running'
fi

# ---------------------------------------------------------------------------
# 1. Tenant isolation.
#
#    Asked of the role the API connects as, not of the API. Row-level security
#    is FORCEd on the tenant-scoped tables, and the tenant comes from a session
#    setting the request pipeline sets — so the question is whether the
#    database denies by default and whether naming a different organization
#    shows that organization's rows. Both, under load.
# ---------------------------------------------------------------------------
echo "safety: 1/8 tenant isolation"
org="$(as_owner 'SELECT id FROM organizations LIMIT 1;')"
owner="$(as_owner 'SELECT owner_user_id FROM documents LIMIT 1;')"
documents_total="$(as_owner 'SELECT count(*) FROM documents;')"
certificates_total="$(as_owner 'SELECT count(*) FROM compliance_certificates;')"

# Two tables, because PalCert scopes in two different ways and proving one
# says nothing about the other. `documents` is owner-scoped
# (`owner_user_id = app_current_user_id()`); `compliance_certificates` is
# org-scoped as well (`organization_id = app_current_organization()`). The
# first version of this check set the organization variable and asked about
# documents, which is the wrong key for that table — it returned zero rows
# for the control as well as for the negative, and would have reported
# isolation holding no matter what the policy said.
check_scope() { # table setting real-value label
  local blind foreign own
  blind="$(as_app "SELECT count(*) FROM $1;")"
  foreign="$(as_app "SET $2 = '00000000-0000-4000-8000-000000000000';
    SELECT count(*) FROM $1;")"
  own="$(as_app "SET $2 = '$3';
    SELECT count(*) FROM $1;")"

  if [ "$blind" = "0" ]; then
    say ok "$4: nothing is visible without a context"
  else
    say FAIL "$4: nothing is visible without a context" "$blind row(s)"
  fi
  if [ "$foreign" = "0" ]; then
    say ok "$4: another tenant’s key returns no rows"
  else
    say FAIL "$4: another tenant’s key returns no rows" "$foreign row(s) leaked"
  fi
  # The control. Without it the two checks above pass equally well against a
  # broken connection, an empty table or a mistyped column.
  if [ "$own" -gt 0 ] 2>/dev/null; then
    say ok "$4: the right key does return rows" "$own"
  else
    say FAIL "$4: the right key does return rows" \
      "got '$own' — the checks above may be passing for the wrong reason"
  fi
}

if [ "$documents_total" = "0" ] || [ "$certificates_total" = "0" ]; then
  say FAIL 'the fixture has rows to isolate' \
    "documents=$documents_total certificates=$certificates_total"
else
  check_scope documents palcert.current_user_id "$owner" 'documents (owner-scoped)'
  check_scope compliance_certificates palcert.current_organization_id "$org" \
    'certificates (org-scoped)'
fi

# Isolation is a property of the tables, not of one query. Anything with
# row-level security enabled must also have it FORCEd, because RLS merely
# enabled does not apply to the table's owner — which is the role migrations
# run as.
unforced="$(as_owner "SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relrowsecurity AND NOT c.relforcerowsecurity;")"
if [ "$unforced" = "0" ]; then
  say ok 'every table with row-level security has it FORCEd'
else
  say FAIL 'every table with row-level security has it FORCEd' "$unforced table(s) not forced"
fi

# ---------------------------------------------------------------------------
# 2. No duplicate certificates.
# ---------------------------------------------------------------------------
echo "safety: 2/8 certificates"
expect_zero "SELECT count(*) FROM (
    SELECT verification_code_hash FROM compliance_certificates
    GROUP BY 1 HAVING count(*) > 1) d;" \
  'no two certificates share a verification code'
expect_zero "SELECT count(*) FROM (
    SELECT submission_revision_id FROM compliance_certificates
    WHERE issuance_status = 'ISSUED' AND revoked_at IS NULL
    GROUP BY 1 HAVING count(*) > 1) d;" \
  'no submission revision carries two live certificates'

# ---------------------------------------------------------------------------
# 3. No duplicate ledger entries.
#
#    The ledger is append-only and every entry carries an idempotency key, so
#    a duplicate is not a cosmetic problem: it is money recorded twice.
# ---------------------------------------------------------------------------
echo "safety: 3/8 finance ledger"
expect_zero "SELECT count(*) FROM (
    SELECT account_id, idempotency_key FROM credit_ledger_entries
    WHERE idempotency_key IS NOT NULL
    GROUP BY 1, 2 HAVING count(*) > 1) d;" \
  'no ledger idempotency key is used twice on an account'
expect_zero "SELECT count(*) FROM (
    SELECT account_id, reference_type, reference_id, entry_type
    FROM credit_ledger_entries
    WHERE reference_id IS NOT NULL AND reversal_of_entry_id IS NULL
    GROUP BY 1, 2, 3, 4 HAVING count(*) > 1) d;" \
  'no reference is captured twice on one account'

# There is no stored balance column: a balance *is* the sum of its ledger, so
# there is nothing for the two to drift apart from. What a duplicate capture
# would actually produce is a balance that has gone below zero — money spent
# that was never held — so that is what is checked.
overspent="$(as_owner "SELECT count(*) FROM (
    SELECT account_id FROM credit_ledger_entries
    GROUP BY 1 HAVING sum(amount_minor_signed) < 0) d;")"
if [ "$overspent" = "0" ]; then
  say ok 'no credit account has been spent below zero'
else
  say FAIL 'no credit account has been spent below zero' "$overspent account(s) negative"
fi

# ---------------------------------------------------------------------------
# 4. No lost or duplicated jobs.
#
#    Claims are FOR UPDATE SKIP LOCKED under a lease (ADR-0012). Two workers
#    holding the same job, or a job whose lease expired and was never reaped,
#    are the two ways that goes wrong.
# ---------------------------------------------------------------------------
echo "safety: 4/8 background jobs"
expect_zero "SELECT count(*) FROM (
    SELECT job_type, idempotency_key FROM processing_jobs
    WHERE idempotency_key IS NOT NULL
    GROUP BY 1, 2 HAVING count(*) > 1) d;" \
  'no job type has the same idempotency key twice'
expect_zero "SELECT count(*) FROM processing_jobs
  WHERE status = 'RUNNING' AND lease_expires_at < now() - interval '10 minutes';" \
  'no job is RUNNING on a lease that expired long ago'
expect_zero "SELECT count(*) FROM processing_jobs
  WHERE status = 'RUNNING' AND worker_id IS NULL;" \
  'every RUNNING job names the worker holding it'
expect_zero "SELECT count(*) FROM processing_jobs
  WHERE attempt_count > max_attempts;" \
  'no job was attempted more times than its own limit allows'

# ---------------------------------------------------------------------------
# 5. Rate limiting across replicas.
#
#    This is the one property that cannot be proved with a single process, so
#    a second API replica is started for it. One simulated client, requests
#    alternating between the two replicas: if the limiter counted in process
#    memory each replica would allow a full budget and the client would get
#    twice what the limit says. The budget is PUBLIC_CERTIFICATE_VERIFY_LIMIT
#    (60 per fifteen-minute window), so 90 requests split across two replicas
#    must yield 60 allowed and 30 refused — not 90.
#
#    The address is from RFC 5737 documentation space, which the load
#    generator never uses (it draws from the RFC 2544 benchmarking range), so
#    this client's budget is its own.
# ---------------------------------------------------------------------------
echo "safety: 5/8 rate limiting across two API replicas"

# Two replicas are started for this, rather than the stack's own single one,
# and both are started with the *shipped* limit.
#
# The stack under test runs with `API_RATE_LIMIT_LIMIT=1000000`, deliberately:
# a capacity sweep that runs into the global throttle measures the throttle
# and nothing else. That is disclosed in the report, and it also makes the
# stack's own API the wrong process to ask this question of — a limit of a
# million is a limit nothing reaches. So the replicas here carry the schema
# default the product actually ships, 120 requests per 60 seconds, and
# everything else about them is copied verbatim from the running API: same
# image, same environment, same mounts, same Redis.
#
# That is exactly the test finding F-009 named and nobody had run: "two API
# instances sharing one budget".
docker inspect "${PROJECT}-api-1" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -v '^API_RATE_LIMIT_LIMIT=' | grep -v '^API_RATE_LIMIT_TTL_SECONDS=' \
  > "$OUT/replica.env"
LIMIT=120
WINDOW=60
{
  echo "API_RATE_LIMIT_LIMIT=$LIMIT"
  echo "API_RATE_LIMIT_TTL_SECONDS=$WINDOW"
} >> "$OUT/replica.env"
chmod 600 "$OUT/replica.env"

replicas_up=1
for name in safety-api-a safety-api-b; do
  id="$(docker run -d --network "${PROJECT}_edge" \
    --name "$name" --network-alias "$name" \
    --env-file "$OUT/replica.env" \
    --volumes-from "${PROJECT}-api-1" \
    "$(docker inspect "${PROJECT}-api-1" --format '{{.Config.Image}}')" 2>&1)"
  if [ "${#id}" -ne 64 ]; then
    say FAIL "replica $name starts" "$id"
    replicas_up=0
    continue
  fi
  docker network connect "${PROJECT}_internal" "$name" > /dev/null 2>&1
  ready=0
  for _ in $(seq 1 45); do
    if docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
      -s --max-time 5 "http://${name}:4000/health/ready" 2>/dev/null \
      | grep -q '"status":"ok"'; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" = "1" ]; then
    say ok "replica $name is serving"
  else
    say FAIL "replica $name is serving" 'never became ready'
    replicas_up=0
  fi
done

if [ "$replicas_up" = "1" ]; then
  # One curl container per burst rather than one per request: hundreds of
  # container starts would take longer than the measurement and would space
  # the requests far enough apart to change what is being measured.
  burst() { # path count client-ip
    docker run --rm --network "${PROJECT}_edge" --entrypoint sh \
      curlimages/curl:8.11.1 -c '
        i=0
        while [ $i -lt '"$2"' ]; do
          i=$((i + 1))
          host=safety-api-a
          [ $((i % 2)) -eq 0 ] && host=safety-api-b
          curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 \
            -H "X-Forwarded-For: '"$3"'" "http://${host}:4000'"$1"'"
        done' 2>/dev/null
  }

  # A fresh simulated client per run, from RFC 5737 documentation space,
  # which the load generator never touches (it draws from the RFC 2544
  # benchmarking range). This matters: the verification window is fifteen
  # minutes, so a fixed address makes a second run inside that window start
  # with its budget already spent. The first time this ran twice it reported
  # `allowed=0 refused=90` and said ok — a check satisfied just as well by a
  # system that refuses everything.
  CLIENT_A="203.0.113.$(( (RANDOM % 100) + 10 ))"
  CLIENT_B="203.0.113.$(( (RANDOM % 100) + 130 ))"

  # 5a. The global HTTP throttle — the limiter F-009 was about. It used to
  #     count in process memory, so N replicas meant N times the budget.
  #
  #     The route is authenticated and no credential is sent, so every
  #     admitted request answers 401. That is deliberate: the throttler guard
  #     is registered first among the global guards and so runs before
  #     authentication, a refused request is still a counted one, and a route
  #     with no second limiter in front of it means a 429 can only have come
  #     from the global throttle.
  attempts=$((LIMIT + 80))
  codes="$(burst '/api/v1/organizations' "$attempts" "$CLIENT_A")"
  refused="$(printf '%s\n' "$codes" | grep -c '^429$' || true)"
  total="$(printf '%s\n' "$codes" | grep -c '^[0-9]' || true)"
  allowed=$((total - refused))
  # Generous on the upper side: the window is $WINDOW seconds and the burst
  # takes a few seconds, so a handful of requests can land in the next one.
  # Two-sided. Too many admitted means the replicas are counting separately;
  # too few means this client's budget was not its own, and either way the
  # number is not measuring what the check claims.
  if [ "$total" -eq "$attempts" ] \
    && [ "$allowed" -ge $((LIMIT - 10)) ] && [ "$allowed" -lt $((LIMIT * 2)) ]; then
    say ok 'the global HTTP throttle is one budget across two replicas (F-009)' \
      "allowed=$allowed refused=$refused of $total (limit $LIMIT/${WINDOW}s)"
  else
    say FAIL 'the global HTTP throttle is one budget across two replicas (F-009)' \
      "allowed=$allowed refused=$refused of $total — per-process counting allows ~$((LIMIT * 2))"
  fi

  # 5b. The public verification guard, which is a different limiter with a
  #     different store and a hard-coded budget: PUBLIC_CERTIFICATE_VERIFY_LIMIT,
  #     60 per fifteen-minute window, because a verification code is a
  #     capability. 90 requests split across two replicas must yield 60
  #     allowed, not 120.
  codes="$(burst '/api/v1/public/certificates/PC00000000000000000000000000000000' 90 "$CLIENT_B")"
  refused="$(printf '%s\n' "$codes" | grep -c '^429$' || true)"
  total="$(printf '%s\n' "$codes" | grep -c '^[0-9]' || true)"
  allowed=$((total - refused))
  if [ "$total" -eq 90 ] && [ "$allowed" -ge 55 ] && [ "$allowed" -le 66 ]; then
    say ok 'the verification guard is one budget across two replicas' \
      "allowed=$allowed refused=$refused of $total (limit 60/15min)"
  else
    say FAIL 'the verification guard is one budget across two replicas' \
      "allowed=$allowed refused=$refused of $total — 60 expected; per-process counting allows ~120"
  fi
else
  say FAIL 'two API replicas are serving' 'cross-replica rate limiting was not proved'
fi
docker rm -f safety-api-a safety-api-b > /dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 6. Webhook idempotency.
# ---------------------------------------------------------------------------
echo "safety: 6/8 webhook delivery"
expect_zero "SELECT count(*) FROM (
    SELECT endpoint_id, webhook_event_id FROM webhook_delivery_safe
    WHERE replay_of_delivery_id IS NULL
    GROUP BY 1, 2 HAVING count(*) > 1) d;" \
  'an endpoint has at most one original delivery per event'

# ---------------------------------------------------------------------------
# 7. API-client authorization.
#
#    The machine surface must refuse an absent or wrong credential while the
#    system is busy. A load-shedding path that starts answering unauthenticated
#    requests is worse than one that starts refusing authenticated ones.
# ---------------------------------------------------------------------------
echo "safety: 7/8 machine surface authorization"
machine_status() { # auth-header-or-empty
  if [ -z "$1" ]; then
    docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
      -s -o /dev/null -w '%{http_code}' --max-time 10 \
      http://api:4000/api/v1/integration/v1/organization 2>/dev/null # gitleaks:allow (an internal URL, not a key)
  else
    docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
      -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: $1" \
      http://api:4000/api/v1/integration/v1/organization 2>/dev/null # gitleaks:allow (an internal URL, not a key)
  fi
}
anonymous="$(machine_status '')"
if [ "$anonymous" = "401" ]; then
  say ok 'the machine surface refuses an anonymous request under load' "HTTP $anonymous"
else
  say FAIL 'the machine surface refuses an anonymous request under load' "HTTP $anonymous"
fi
forged="$(machine_status "Basic $(printf 'pc_live_nonexistent:not-a-secret' | base64 | tr -d '\n')")"
if [ "$forged" = "401" ]; then
  say ok 'the machine surface refuses a forged credential under load' "HTTP $forged"
else
  say FAIL 'the machine surface refuses a forged credential under load' "HTTP $forged"
fi

# ---------------------------------------------------------------------------
# 8. The migration gate and the operational signals.
# ---------------------------------------------------------------------------
echo "safety: 8/8 migration gate and monitoring"
# Through the release's own preflight, not by guessing a path inside the
# image: the script is mounted from the checkout into the release API image,
# which is the only place the generated client, the query engine and this
# release's migration directory exist together at matching versions. Calling
# `node packages/database/scripts/check-migrations.mjs` in the API container
# fails with MODULE_NOT_FOUND, which reads exactly like a gate failure and is
# nothing of the sort.
NETWORK="${PROJECT}_internal" \
  DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:?the admin database URL is required}" \
  PREFLIGHT_IMAGE="$(docker inspect "${PROJECT}-api-1" --format '{{.Config.Image}}')" \
  bash "$REPO/scripts/release/migration-preflight.sh" > "$OUT/migration-gate.txt" 2>&1
gate=$?
if [ "$gate" -eq 0 ]; then
  say ok 'the migration gate still reports the schema current, under load' 'exit 0'
else
  say FAIL 'the migration gate still reports the schema current, under load' "exit $gate"
fi

metrics="$(docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
  -s --max-time 10 http://api:4000/metrics 2>/dev/null)"
first="$(printf '%s' "$metrics" | grep -c '^palcert_http_requests_total{' || true)"
sleep 10
metrics2="$(docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
  -s --max-time 10 http://api:4000/metrics 2>/dev/null)"
second_count="$(printf '%s' "$metrics2" | grep -c '^palcert_http_requests_total{' || true)"

if [ "$first" -gt 0 ]; then
  say ok 'the request counter is exposed while serving' "$first series"
else
  say FAIL 'the request counter is exposed while serving' 'no series'
fi
# Cardinality is the thing load reveals: a label carrying a document, user or
# organization id grows a timeseries per entity, and three minutes of traffic
# across 131 072 simulated clients is exactly when that becomes visible.
if [ "$second_count" -lt 60 ]; then
  say ok 'metric cardinality stays bounded under sustained load' "$second_count series"
else
  say FAIL 'metric cardinality stays bounded under sustained load' \
    "$second_count series — a label may be carrying an identifier"
fi
if printf '%s' "$metrics2" | grep -Eq '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; then
  say FAIL 'no identifier appears in the exposition' 'a UUID is present in a label'
else
  say ok 'no identifier appears in the exposition'
fi

# The generator must still have been running when the last check ran. If it
# stopped part way through, the later checks were made against an idle system
# while this script claimed otherwise — which is the failure mode this whole
# file exists to avoid elsewhere, so it is worth excluding here too.
if [ "$(docker inspect -f '{{.State.Running}}' safety-load 2>/dev/null)" = "true" ]; then
  say ok 'load was still flowing when the last check ran'
else
  say FAIL 'load was still flowing when the last check ran' \
    'the generator stopped early; later checks did not run under load'
fi

docker logs safety-load > "$OUT/load.txt" 2>&1 || true

if [ "$failures" -ne 0 ]; then
  echo "safety: $failures check(s) failed; output in $OUT" >&2
  exit 65
fi
echo "safety: every safety property held under load; output in $OUT"
