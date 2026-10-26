#!/usr/bin/env bash
# The named security regression suite (Phase 20 Checkpoint 7, requirement 29).
#
#   bash scripts/security/security-suite.sh
#
# Not a new set of tests. It is the existing ones, named and grouped by the
# property each one defends, so that "the security suite passed" means
# something specific and so that a gap is visible as a missing group rather
# than as an absence nobody notices.
#
# Runs against the e2e database, in band, exactly as the full suite does.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

# Group → suites. The comment above each group is the question it answers.
groups=(
  # Upload and parser boundary: a document is data, never something that runs.
  "upload-boundary:documents-security documents-storage documents-lifecycle analysis-lifecycle pdf-checks"
  # Server-side request forgery on every outbound path.
  "ssrf:webhooks-api webhooks-workers"
  # Cross-tenant isolation, at the API and at the database.
  "isolation:security-rls-matrix tenant-isolation tenant-rls-coverage tenant-connection-safety documents-isolation checks-isolation submissions-isolation finance-isolation paid-check-isolation smartfix-isolation ai-isolation analysis-isolation extraction-isolation standards-isolation webhooks-privacy"
  # Machine credentials (Phase 19).
  "api-clients:api-clients-security api-clients-journey rate-limit-distribution"
  # Webhook signing, keyring, rotation and redaction (Phase 17).
  "webhooks:webhooks-authority webhooks-system-authority webhooks-database notifications-recovery"
  # Money.
  "finance:finance-isolation finance-holds finance-refunds finance-database paid-check-races"
  # Certificates: who may issue, and what a verification code discloses.
  "certificates:certificates-eligibility certificates-integrity certificates-verification certificates-verification-code certificates-database"
  # Browser and edge security (Phase 20 Checkpoint 7).
  "edge:proxy-trust-and-cors auth-security payments-disabled observability health"
)

failures=0
summary=()

for entry in "${groups[@]}"; do
  name="${entry%%:*}"
  suites="${entry#*:}"
  files=""
  for suite in $suites; do
    path="test/${suite}.e2e-spec.ts"
    if [ ! -f "$REPO/apps/api/$path" ]; then
      echo "security-suite: MISSING $path" >&2
      failures=$((failures + 1))
      continue
    fi
    files="$files $path"
  done

  echo "security-suite: === ${name} ==="
  # shellcheck disable=SC2086
  (cd "$REPO/apps/api" && STORAGE_ENFORCES_SIGNATURES=false \
    pnpm exec jest --config jest-e2e.config.js --runInBand $files) \
    > "$OUT/${name}.log" 2>&1
  status=$?
  line="$(grep -E '^Tests:' "$OUT/${name}.log" | tail -1)"
  if [ "$status" -eq 0 ]; then
    echo "security-suite: ok   ${name}  ${line}"
    summary+=("ok   ${name}  ${line}")
  else
    echo "security-suite: FAIL ${name}  ${line}"
    summary+=("FAIL ${name}  ${line}")
    grep -m 3 -A 8 '●.*›' "$OUT/${name}.log" | head -30
    failures=$((failures + 1))
  fi
done

echo
echo "security-suite: summary"
for line in "${summary[@]}"; do echo "security-suite:   $line"; done

if [ "$failures" -ne 0 ]; then
  echo "security-suite: $failures group(s) failed; logs in $OUT" >&2
  exit 65
fi
echo "security-suite: every group passed; logs in $OUT"
