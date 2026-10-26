#!/usr/bin/env bash
# Prove the running system is the release that was meant to be deployed
# (Phase 20 Checkpoint 5).
#
#   ./verify-release-identity.sh release-manifest.json env-file [compose-file]
#
# Asked of the system through the endpoints an operator would use, not of the
# deployment tool. The deployment tool believes what it was told; the running
# process reports what it actually is, and a rollback is only trustworthy if
# those two can be compared.
#
# Runs before ingress opens. A release that cannot say which commit it is
# cannot be rolled back with confidence, so it does not get traffic.
set -euo pipefail

MANIFEST="${1:?release manifest required}"
ENV_FILE="${2:?env file required}"
COMPOSE="${3:-docker/docker-compose.release.yml}"
# The worker starts after the API has proved itself, so between those two
# points the stack is legitimately worker-less and asking it for readiness
# would fail for a reason that is not a fault.
WITHOUT_WORKER=0
for argument in "$@"; do
  [ "$argument" = "--without-worker" ] && WITHOUT_WORKER=1
done
PROJECT="${COMPOSE_PROJECT_NAME:-palcert-release}"

commit=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['commit'])")
release=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['releaseVersion'])")

compose_files=(-f "$COMPOSE")
[ -n "${COMPOSE_OVERRIDE:-}" ] && compose_files+=(-f "$COMPOSE_OVERRIDE")
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${compose_files[@]}" "$@"; }

probe() { docker run --rm --network "$1" curlimages/curl:8.11.1 -sk "$2"; }

failed=0
say() { printf 'verify-identity: %-4s %s — %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && failed=1 || true; }

# --- the API, through its readiness surface -------------------------------
ready=$(probe "${PROJECT}_edge" http://api:4000/health/ready || true)
if echo "$ready" | grep -q '"status":"ok"'; then
  say ok "api readiness" "status ok"
else
  say FAIL "api readiness" "$(echo "$ready" | head -c 160)"
fi
if echo "$ready" | grep -q "\"commit\":\"$commit\""; then
  say ok "api reports the deployed commit" "${commit:0:12}"
else
  say FAIL "api reports the deployed commit" "expected ${commit:0:12}"
fi

# --- the worker, which has its own readiness --------------------------------
if [ "$WITHOUT_WORKER" -eq 1 ]; then
  say ok "worker readiness" "not started yet at this stage"
else
  worker=$(probe "${PROJECT}_internal" http://worker:4100/health/ready || true)
  if echo "$worker" | grep -q '"status":"ok"'; then
    say ok "worker readiness" "status ok"
  else
    say FAIL "worker readiness" "$(echo "$worker" | head -c 160)"
  fi
fi

# --- the document engine ----------------------------------------------------
engine=$(probe "${PROJECT}_internal" http://document-engine:8000/health/ready || true)
if echo "$engine" | grep -qi 'ok'; then
  say ok "document engine readiness" "reachable"
else
  say FAIL "document engine readiness" "$(echo "$engine" | head -c 160)"
fi

# --- release identity in telemetry -----------------------------------------
# `palcert_build_info` is how an operator answers "what is running" from a
# dashboard rather than by reading a deployment log.
metrics=$(probe "${PROJECT}_edge" http://api:4000/metrics || true)
# A here-string, not a pipe: a busy API's exposition is larger than a pipe
# buffer, and under pipefail `grep -q` stopping early would fail the write.
if grep -q "palcert_build_info{.*commit=\"$commit\"" <<< "$metrics"; then
  say ok "telemetry carries the release commit" "palcert_build_info"
else
  say FAIL "telemetry carries the release commit" "palcert_build_info missing or wrong"
fi

# --- the images actually running are the manifest's digests -----------------
# The strongest statement available: not "we asked for this digest" but "the
# container that exists was created from it".
expected_digests=$(mktemp)
python3 - "$MANIFEST" "$WITHOUT_WORKER" > "$expected_digests" <<'EXPECTED'
import json, sys
manifest = json.load(open(sys.argv[1]))
mapping = {'api': 'api', 'worker': 'worker', 'web': 'web', 'documentEngine': 'document-engine'}
if sys.argv[2] == '1':
    del mapping['worker']
for component, service in mapping.items():
    print(f"{service} {manifest['images'][component]['digest']}")
EXPECTED
while read -r service digest; do
  container="${PROJECT}-${service}-1"
  actual=$(docker inspect "$container" --format '{{index .Config.Image}}' 2>/dev/null || echo '(absent)')
  if [ "$actual" = "(absent)" ]; then
    say FAIL "$service runs the release image" "container not found"
  elif [[ "$actual" == *"$digest"* ]]; then
    say ok "$service runs the release image" "${digest:0:19}…"
  else
    say FAIL "$service runs the release image" "running $actual"
  fi
done < "$expected_digests"
rm -f "$expected_digests"

if [ "$failed" -ne 0 ]; then
  echo "verify-identity: $release did not verify; ingress must not open" >&2
  exit 65
fi
echo "verify-identity: $release verified (${commit:0:12})"
