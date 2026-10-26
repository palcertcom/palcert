#!/usr/bin/env bash
# Security behaviour through the real release proxy (Phase 20 Checkpoint 7).
#
#   BASE=https://localhost:8543 PROJECT=palcert-c7 bash scripts/security/proxy-security-smoke.sh
#
# Everything here is asked of the published surface, over TLS, exactly as the
# internet would ask it. That distinction is the whole point: a header set in
# a config object, a CORS list in a schema and a trust model in `bootstrap.ts`
# are all statements of intent, and the only way to know what a deployment
# actually does is to send it a request.
#
# Where a check needs to compare proxied against direct access, it runs the
# second half from a throwaway container on the deployment network, because
# "the outside cannot forge this" and "nothing inside can either" are
# different claims and only the first one is being made.
set -uo pipefail

BASE="${BASE:-https://localhost:8543}"
PROJECT="${PROJECT:-palcert-c7}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://localhost:8543}"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

failures=0
say() {
  printf 'proxy-smoke: %-4s %-62s %s\n' "$1" "$2" "${3:-}"
  [ "$1" = FAIL ] && failures=$((failures + 1)) || true
}

get() { curl -sk --max-time 15 "$@"; }
code() { curl -sk --max-time 15 -o /dev/null -w '%{http_code}' "$@"; }
headers() { curl -sk --max-time 15 -D - -o /dev/null "$@"; }

# From inside the deployment network, addressing the API directly.
internal() {
  docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 -s --max-time 15 "$@" 2>/dev/null
}
internal_code() {
  docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
    -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null
}

MISS='PC0000000000000000000000000000000B'
VERIFY="/api/v1/public/certificates/${MISS}"

echo "proxy-smoke: base=$BASE project=$PROJECT out=$OUT"

# ---------------------------------------------------------------------------
# 1. Security headers, on the real responses.
# ---------------------------------------------------------------------------
echo "proxy-smoke: 1/6 security headers"
web_headers="$(headers "$BASE/en")"
printf '%s' "$web_headers" > "$OUT/web-headers.txt"

expect_header() { # haystack name pattern label
  local value
  value="$(printf '%s' "$1" | grep -i "^$2:" | head -1 | tr -d '\r')"
  if [ -z "$value" ]; then
    say FAIL "$4" "no $2 header"
  elif printf '%s' "$value" | grep -qiE "$3"; then
    say ok "$4" "${value:0:72}"
  else
    say FAIL "$4" "$value"
  fi
}

expect_header "$web_headers" 'content-security-policy' "default-src 'none'" 'web: a Content-Security-Policy that denies by default'
expect_header "$web_headers" 'content-security-policy' "frame-ancestors 'none'" 'web: framing refused'
expect_header "$web_headers" 'content-security-policy' "base-uri 'none'" 'web: base-uri locked'
expect_header "$web_headers" 'strict-transport-security' 'max-age=3153600' 'web: HSTS for a year'
expect_header "$web_headers" 'x-content-type-options' 'nosniff' 'web: no MIME sniffing'
expect_header "$web_headers" 'referrer-policy' 'no-referrer' 'web: no referrer'
expect_header "$web_headers" 'x-frame-options' 'DENY' 'web: X-Frame-Options for older browsers'
expect_header "$web_headers" 'permissions-policy' 'camera=\(\)' 'web: powerful features denied'

if printf '%s' "$web_headers" | grep -qi 'unsafe-eval'; then
  say FAIL 'web: no unsafe-eval in the production policy'
else
  say ok 'web: no unsafe-eval in the production policy'
fi

api_headers="$(headers "$BASE$VERIFY")"
printf '%s' "$api_headers" > "$OUT/api-headers.txt"
expect_header "$api_headers" 'strict-transport-security' 'max-age=3153600' 'api: HSTS for a year'
expect_header "$api_headers" 'x-content-type-options' 'nosniff' 'api: no MIME sniffing'
expect_header "$api_headers" 'content-security-policy' "default-src 'none'" 'api: JSON surface denies by default'

if printf '%s' "$web_headers$api_headers" | grep -qi '^x-powered-by:'; then
  say FAIL 'no framework advertised in response headers'
else
  say ok 'no framework advertised in response headers'
fi

# ---------------------------------------------------------------------------
# 2. Public endpoints stay distinguishable.
# ---------------------------------------------------------------------------
# Deliberately early. The forwarded-header section below spends this client's
# entire per-IP verification budget in order to show that a forged address
# does not buy a fresh one — so anything that needs a *served* answer from the
# verification endpoint has to ask before that happens. The first version of
# this file asked afterwards, got a 429, and reported "an unknown certificate
# is named as such" as a failure of the product rather than of its own
# ordering.
echo "proxy-smoke: 2/6 public verification"
# Checkpoint 20.5 shipped a smoke check that probed an unversioned path, got a
# 404 because the route did not exist, and reported it as the endpoint
# correctly rejecting an unknown certificate. The two must stay tellable
# apart, so both are asserted rather than just the status code.
unknown="$(get "$BASE$VERIFY")"
wrong_route="$(get "$BASE/api/v1/public/certificates-typo/$MISS")"
if printf '%s' "$unknown" | grep -q 'CERTIFICATE_NOT_FOUND'; then
  say ok 'an unknown certificate is named as such'
else
  say FAIL 'an unknown certificate is named as such' "${unknown:0:100}"
fi
if printf '%s' "$wrong_route" | grep -q 'CERTIFICATE_NOT_FOUND'; then
  say FAIL 'a wrong route is distinguishable from an unknown certificate' \
    'the mistyped path answered as if the certificate were merely absent'
else
  say ok 'a wrong route is distinguishable from an unknown certificate'
fi

# ---------------------------------------------------------------------------
# 3. CORS.
# ---------------------------------------------------------------------------
echo "proxy-smoke: 3/6 CORS"
allowed="$(headers -H "Origin: $ALLOWED_ORIGIN" "$BASE$VERIFY" | grep -i '^access-control-allow-origin:' | tr -d '\r')"
if printf '%s' "$allowed" | grep -q "$ALLOWED_ORIGIN"; then
  say ok 'the configured web origin is allowed' "$allowed"
else
  say FAIL 'the configured web origin is allowed' "${allowed:-absent}"
fi

foreign="$(headers -H 'Origin: https://attacker.example' "$BASE$VERIFY" | grep -ci '^access-control-allow-origin:' || true)"
if [ "$foreign" = "0" ]; then
  say ok 'an arbitrary origin gets no allow-origin header at all'
else
  say FAIL 'an arbitrary origin gets no allow-origin header at all' "$foreign header(s)"
fi

wildcard="$(headers -H "Origin: $ALLOWED_ORIGIN" "$BASE$VERIFY" | grep -ci 'access-control-allow-origin: \*' || true)"
credentials="$(headers -H "Origin: $ALLOWED_ORIGIN" "$BASE$VERIFY" | grep -ci 'access-control-allow-credentials: true' || true)"
if [ "$wildcard" = "0" ] && [ "$credentials" != "0" ]; then
  say ok 'credentials are allowed, and never alongside a wildcard origin'
else
  say FAIL 'credentials are allowed, and never alongside a wildcard origin' \
    "wildcard=$wildcard credentials=$credentials"
fi

preflight="$(headers -X OPTIONS -H "Origin: $ALLOWED_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-csrf-token' \
  "$BASE/api/v1/organizations" | grep -i '^access-control-allow-origin:' | tr -d '\r')"
if printf '%s' "$preflight" | grep -q "$ALLOWED_ORIGIN"; then
  say ok 'preflight answers for the allowed origin' "$preflight"
else
  say FAIL 'preflight answers for the allowed origin' "${preflight:-absent}"
fi

# ---------------------------------------------------------------------------
# 4. Forwarded headers.
# ---------------------------------------------------------------------------
echo "proxy-smoke: 4/6 forwarded headers"

# The proxy must *replace* what the client sent, not extend it. Asked of the
# one endpoint that reflects a decision made from the client address: the
# per-IP verification guard. A forged address that were believed would give
# this caller a fresh budget on every request.
forged_spent=0
for index in $(seq 1 70); do
  status="$(code -H "X-Forwarded-For: 198.18.$((index % 256)).$(((index * 7) % 256))" "$BASE$VERIFY")"
  [ "$status" = "429" ] && forged_spent=$((forged_spent + 1))
done
if [ "$forged_spent" -gt 0 ]; then
  say ok 'a forged X-Forwarded-For does not buy a fresh rate-limit budget' \
    "$forged_spent of 70 refused"
else
  say FAIL 'a forged X-Forwarded-For does not buy a fresh rate-limit budget' \
    'every request was admitted — the claimed address was believed'
fi

# X-Forwarded-Proto and X-Forwarded-Host: the proxy sets both, so a client
# value never reaches the application. Checked by asking for something whose
# answer would change if it did — an absolute URL or a redirect built from the
# host — and confirming the attacker's host does not appear anywhere.
poisoned="$(get -H 'X-Forwarded-Host: attacker.example' -H 'X-Forwarded-Proto: http' "$BASE/en" | head -c 400000)"
if printf '%s' "$poisoned" | grep -qi 'attacker.example'; then
  say FAIL 'a forged X-Forwarded-Host does not appear in the response'
else
  say ok 'a forged X-Forwarded-Host does not appear in the response'
fi

still_hsts="$(headers -H 'X-Forwarded-Proto: http' "$BASE/en" | grep -ci '^strict-transport-security:' || true)"
if [ "$still_hsts" != "0" ]; then
  say ok 'a forged X-Forwarded-Proto does not downgrade the secure-origin decision'
else
  say FAIL 'a forged X-Forwarded-Proto does not downgrade the secure-origin decision' \
    'HSTS disappeared, so the claimed scheme was believed'
fi

# ---------------------------------------------------------------------------
# 5. Internal reachability, separately from proxied access.
# ---------------------------------------------------------------------------
echo "proxy-smoke: 5/6 internal versus proxied"
metrics_outside="$(code "$BASE/metrics")"
if [ "$metrics_outside" = "404" ]; then
  say ok 'telemetry is not reachable from outside, and does not admit it exists' "HTTP $metrics_outside"
else
  say FAIL 'telemetry is not reachable from outside' "HTTP $metrics_outside"
fi

metrics_inside="$(internal_code http://api:4000/metrics)"
if [ "$metrics_inside" = "200" ]; then
  say ok 'telemetry is reachable on the deployment network, where a scraper runs' "HTTP $metrics_inside"
else
  say FAIL 'telemetry is reachable on the deployment network' "HTTP $metrics_inside"
fi

# The interesting half: a caller *inside* the network, addressing the API
# directly, gets no more trust than one outside. `uniquelocal` covers the
# Docker network, so this container is a trusted upstream — which is the
# deployment's stated model, and the reason the claim being made is "the
# outside cannot forge", not "nothing can".
internal_forged=0
for index in $(seq 1 70); do
  status="$(internal_code -H "X-Forwarded-For: 203.0.113.$((index % 256))" \
    "http://api:4000${VERIFY}")"
  [ "$status" = "429" ] && internal_forged=$((internal_forged + 1))
done
if [ "$internal_forged" -gt 0 ]; then
  say ok 'the deployment network is the trust boundary, and it is bounded' \
    "$internal_forged of 70 refused even from inside"
else
  say info 'a trusted upstream can assert a client address, by design' \
    'this is what API_TRUSTED_PROXIES grants; the topology is the control'
fi

# ---------------------------------------------------------------------------
# 6. Production debug behaviour.
# ---------------------------------------------------------------------------
echo "proxy-smoke: 6/6 debug surfaces"
docs="$(code "$BASE/api/docs")"
if [ "$docs" = "404" ] || [ "$docs" = "403" ]; then
  say ok 'the API explorer is not published' "HTTP $docs"
else
  say FAIL 'the API explorer is not published' "HTTP $docs"
fi

# A deliberately malformed request. What must come back is a named error, not
# a stack trace, a SQL fragment or a driver message.
malformed="$(get -X POST -H 'Content-Type: application/json' -H "Origin: $ALLOWED_ORIGIN" \
  --data '{"email":' "$BASE/api/v1/auth/login")"
printf '%s' "$malformed" > "$OUT/malformed-response.json"
if printf '%s' "$malformed" | grep -qiE 'at [A-Za-z]+\.|node_modules|/app/dist|prisma|postgres|SELECT |stack'; then
  say FAIL 'a malformed request produces no stack trace or internal detail' "${malformed:0:120}"
else
  say ok 'a malformed request produces no stack trace or internal detail' "${malformed:0:72}"
fi

notfound="$(get "$BASE/api/v1/this-route-does-not-exist")"
if printf '%s' "$notfound" | grep -qiE 'node_modules|/app/dist|at [A-Za-z]+\.'; then
  say FAIL 'an unknown route leaks nothing about the server'
else
  say ok 'an unknown route leaks nothing about the server'
fi

if [ "$failures" -ne 0 ]; then
  echo "proxy-smoke: $failures check(s) failed; output in $OUT" >&2
  exit 65
fi
echo "proxy-smoke: every check passed; output in $OUT"
