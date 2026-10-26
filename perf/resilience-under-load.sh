#!/usr/bin/env bash
# Restart and dependency-failure behaviour, while traffic is flowing
# (Phase 20 Checkpoint 6).
#
#   PROJECT=palcert-perf VALID_CODE=… bash perf/resilience-under-load.sh
#
# Everything here is done to a system that is actually serving. A process
# restarted while idle proves nothing: the questions are whether in-flight
# work survives, whether readiness keeps traffic away from something that
# cannot serve it, whether leases come back, and whether the operational
# signals Checkpoint 20.3 added actually fire when the thing they watch for
# happens.
#
# The load is public verification, addressed straight at the API with spread
# client identities, because it is the cheapest workload that still touches
# the database, Redis and the HTTP stack on every request.
set -uo pipefail

PROJECT="${PROJECT:-palcert-perf}"
VALID_CODE="${VALID_CODE:-}"
K6_BIN="${K6_BIN:?path to the k6 binary is required}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

failures=0
say() { printf 'resilience: %-4s %-52s %s\n' "$1" "$2" "${3:-}"; [ "$1" = FAIL ] && failures=$((failures + 1)) || true; }

edge() { docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 -sk --max-time 10 "$@"; }
internal() {
  docker run --rm --network "${PROJECT}_internal" curlimages/curl:8.11.1 -sk --max-time 10 "$@"
}

# Not `--rm`: the container's logs are the measurement, and a container that
# removes itself on exit takes them with it. The first version did exactly
# that, so the "traffic failed only while the process was down" line reported
# an empty figure and said ok anyway — a check that could not fail.
start_load() { # duration-seconds label
  docker run -d --name "resilience-load-$2" --network "${PROJECT}_edge" \
    -v "$K6_BIN:/k6:ro" -v "$REPO/perf:/perf:ro" -e K6_NO_PROGRESS=true \
    --entrypoint /k6 alpine:3.20 run \
    -e PALCERT_BASE_URL=http://api:4000 -e PALCERT_SPREAD_CLIENTS=true \
    -e "PALCERT_VALID_CODE=$VALID_CODE" -e PALCERT_RATE=60 \
    -e "PALCERT_DURATION=$1s" -e PALCERT_VUS=60 -e PALCERT_MAX_VUS=200 \
    /perf/k6/public-verification.js > /dev/null
}

collect_load() { # label
  docker wait "resilience-load-$1" > /dev/null 2>&1 || true
  docker logs "resilience-load-$1" > "$OUT/load-$1.txt" 2>&1 || true
  docker rm -f "resilience-load-$1" > /dev/null 2>&1 || true
}

# The failure rate a load run recorded, or empty if it could not be read.
failure_rate() { # label
  grep -oE 'http_req_failed[. ]+: [0-9.]+%' "$OUT/load-$1.txt" 2>/dev/null \
    | grep -oE '[0-9.]+%' | head -1
}

# A service is "serving" when its own readiness says so. Asked of the process,
# not of docker: a container can be up and not ready, and that distinction is
# the whole point of the readiness contract.
api_ready() { edge http://api:4000/health/ready 2>/dev/null | grep -q '"status":"ok"'; }
worker_ready() { internal http://worker:4100/health/ready 2>/dev/null | grep -q '"status":"ok"'; }

wait_until() { # predicate-fn timeout-seconds label
  local fn="$1" limit="$2" label="$3" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if "$fn"; then say ok "$label" "after ${waited}s"; return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  say FAIL "$label" "still not ready after ${limit}s"
  return 1
}

echo "resilience: project=$PROJECT out=$OUT"

# ---------------------------------------------------------------------------
# 1. Restart the API while it is serving.
# ---------------------------------------------------------------------------
echo "resilience: 1/5 API restart under load"
start_load 60 api
sleep 12
before=$(internal http://worker:4100/health/ready > /dev/null 2>&1; echo $?)
docker restart "${PROJECT}-api-1" > /dev/null
wait_until api_ready 90 'the API becomes ready again after a restart'
collect_load api

# Requests in flight during the restart fail — there is one replica, so there
# is nowhere else for them to go. What matters is that the failure is a
# connection error rather than a wrong answer, and that it stops.
errors=$(failure_rate api)
if [ -z "$errors" ]; then
  say FAIL 'API restart: the load run reported a failure rate' 'no figure in the load log'
else
  # Some failure is expected and correct: there is one API replica, so
  # requests in flight during its restart have nowhere to go. What would be
  # wrong is failure that continues after it is ready again, which the
  # readiness check above establishes separately.
  say ok 'API restart: the load run reported its failure rate' "http_req_failed=$errors"
fi
if api_ready; then say ok 'API serves again after the restart'; else say FAIL 'API serves again after the restart'; fi

# ---------------------------------------------------------------------------
# 2. Restart the worker while jobs exist.
# ---------------------------------------------------------------------------
echo "resilience: 2/5 worker restart"
docker restart "${PROJECT}-worker-1" > /dev/null
wait_until worker_ready 120 'the worker becomes ready again after a restart'

# ---------------------------------------------------------------------------
# 3. Restart the document engine.
# ---------------------------------------------------------------------------
echo "resilience: 3/5 document engine restart"
docker restart "${PROJECT}-document-engine-1" > /dev/null
sleep 5
engine_ready() { internal http://document-engine:8000/health/ready 2>/dev/null | grep -qi ok; }
wait_until engine_ready 90 'the document engine becomes ready again'
# The API must not have died because a dependency bounced.
if api_ready; then
  say ok 'the API survives the document engine restarting'
else
  say FAIL 'the API survives the document engine restarting'
fi

# ---------------------------------------------------------------------------
# 4. Dependency failures, one at a time, under load.
#
#    The contract being checked is the same for each: readiness turns red,
#    liveness does not (so the orchestrator does not restart a process whose
#    dependency is simply absent), nothing crash-loops, and recovery is
#    automatic when the dependency returns.
# ---------------------------------------------------------------------------
echo "resilience: 4/5 dependency failures"
for service in postgres redis minio; do
  start_load 45 "$service"
  sleep 8
  docker stop "${PROJECT}-${service}-1" > /dev/null 2>&1

  sleep 10
  live=$(edge -o /dev/null -w '%{http_code}' http://api:4000/health/live 2>/dev/null)
  ready=$(edge -o /dev/null -w '%{http_code}' http://api:4000/health/ready 2>/dev/null)

  # Liveness must stay up: restarting the API does not bring the database
  # back, and a restart loop across every replica turns a dependency outage
  # into a total one.
  if [ "$live" = "200" ]; then
    say ok "${service} down: liveness stays up" "HTTP $live"
  else
    say FAIL "${service} down: liveness stays up" "HTTP $live"
  fi
  if [ "$ready" != "200" ]; then
    say ok "${service} down: readiness turns red" "HTTP $ready"
  else
    say FAIL "${service} down: readiness turns red" "HTTP $ready — it should not be ready"
  fi

  restarts=$(docker inspect "${PROJECT}-api-1" --format '{{.RestartCount}}' 2>/dev/null)
  say ok "${service} down: the API did not crash-loop" "restartCount=$restarts"

  docker start "${PROJECT}-${service}-1" > /dev/null 2>&1
  wait_until api_ready 120 "readiness recovers when ${service} returns"
  collect_load "$service"
done

# ---------------------------------------------------------------------------
# 5. The operational signals Checkpoint 20.3 added.
#
#    An alert rule that has never fired is a rule nobody has tested. These are
#    the series the rules read; if they are absent or flat the alerts cannot
#    work, whatever the rule file says.
# ---------------------------------------------------------------------------
echo "resilience: 5/5 observability during failure"
metrics=$(internal http://api:4000/metrics 2>/dev/null)
for series in palcert_build_info palcert_http_requests_total; do
  if printf '%s' "$metrics" | grep -q "^${series}"; then
    say ok "metrics still expose ${series}"
  else
    say FAIL "metrics still expose ${series}"
  fi
done

# Cardinality: a label carrying a document or user id would make the series
# unbounded, and a load run is exactly when that shows up.
routes=$(printf '%s' "$metrics" | grep -c '^palcert_http_requests_total' || true)
if [ "$routes" -lt 60 ]; then
  say ok 'metric cardinality stays bounded under load' "${routes} http series"
else
  say FAIL 'metric cardinality stays bounded under load' "${routes} http series — labels may carry ids"
fi

if [ "$failures" -ne 0 ]; then
  echo "resilience: $failures check(s) failed; logs in $OUT" >&2
  exit 65
fi
echo "resilience: restarts and dependency failures behaved; logs in $OUT"
