#!/usr/bin/env bash
# Prove the shipped images carry no build-time or fixture secrets
# (Phase 20 Checkpoint 5).
#
#   IMAGE_REFS="ghcr.io/…@sha256:… …" ./check-image-secrets.sh
#
# Two distinct mistakes, both easy and both invisible once an image is
# published:
#
#   - a secret passed as a build argument, which ends up in the image's own
#     configuration where `docker inspect` will show it to anyone who can pull;
#   - a `.env` or a test fixture copied into a layer by a careless COPY.
#
# Checks configuration exhaustively and the filesystem for the specific
# placeholder values PalCert's own fixtures use, because those are the ones
# that would actually be there.
set -euo pipefail

if [ -z "${IMAGE_REFS:-}" ]; then
  echo "check-image-secrets: IMAGE_REFS is required (one reference per line)" >&2
  exit 78
fi

# Environment variable names whose presence in an image's configuration is a
# leak, regardless of value.
FORBIDDEN_ENV='(PASSWORD|SECRET|ENCRYPTION_KEYS|ACCESS_KEY|DATABASE_URL|DATABASE_ADMIN_URL|TOKEN|CREDENTIAL)'
# Values that appear only in development and test material.
FIXTURE_VALUES='palcert_local_dev|palcert_app_local_dev_password|test-secret-key|test-access-key|sk_test_ci_placeholder|drill_pg_password'

failed=0
while IFS= read -r reference; do
  [ -z "${reference// }" ] && continue
  name=$(basename "${reference%@*}")
  echo "check-image-secrets: $name"

  config=$(docker inspect --format '{{json .Config}}' "$reference")

  leaked=$(python3 - "$config" <<'PY'
import json, re, sys
config = json.loads(sys.argv[1])
pattern = re.compile(r'(PASSWORD|SECRET|ENCRYPTION_KEYS|ACCESS_KEY|DATABASE_URL|DATABASE_ADMIN_URL|TOKEN|CREDENTIAL)')
bad = []
for entry in config.get('Env') or []:
    name = entry.split('=', 1)[0]
    if pattern.search(name):
        bad.append(name)
for key, value in (config.get('Labels') or {}).items():
    if pattern.search(key):
        bad.append(f'label:{key}')
print(' '.join(sorted(set(bad))))
PY
)
  if [ -n "${leaked// }" ]; then
    echo "check-image-secrets:   configuration carries: $leaked" >&2
    failed=1
  else
    echo "check-image-secrets:   configuration clean"
  fi

  # The filesystem, for fixture values. Exported rather than run, so nothing
  # in the image executes during the check.
  #
  # `grep -c` rather than `grep -q`, and the count tested afterwards rather
  # than the pipeline's exit status. That is not a style preference. `grep -q`
  # stops reading at the first match, which closes the pipe and kills
  # `docker export` with SIGPIPE; under `set -o pipefail` the pipeline then
  # reports failure *precisely when a secret was found*, and the `if` took
  # that as "no secret". Both filesystem checks were inverted and could only
  # ever report clean. `grep -c` consumes the whole stream, so nothing
  # upstream is signalled, and it exits 1 on zero matches — hence `|| true`,
  # with the count carrying the answer instead.
  if docker create --name "secret-probe-$$" "$reference" > /dev/null 2>&1; then
    dotenv=$(docker export "secret-probe-$$" 2>/dev/null \
      | tar -tf - 2>/dev/null | grep -cE '(^|/)\.env(\.|$)' || true)
    fixtures=$(docker export "secret-probe-$$" 2>/dev/null \
      | grep -acE "$FIXTURE_VALUES" || true)
    docker rm -f "secret-probe-$$" > /dev/null 2>&1 || true

    if [ "${dotenv:-0}" -gt 0 ]; then
      echo "check-image-secrets:   an .env file is present in a layer" >&2
      failed=1
    fi
    if [ "${fixtures:-0}" -gt 0 ]; then
      echo "check-image-secrets:   a development or fixture credential is present in a layer" >&2
      failed=1
    fi
    if [ "${dotenv:-0}" -eq 0 ] && [ "${fixtures:-0}" -eq 0 ]; then
      echo "check-image-secrets:   filesystem clean"
    fi
  else
    # A container that cannot be created is a check that did not run, which is
    # not the same as a clean image and must not be reported as one.
    echo "check-image-secrets:   could not inspect the filesystem of $name" >&2
    failed=1
  fi
done <<< "$IMAGE_REFS"

if [ "$failed" -ne 0 ]; then
  echo "check-image-secrets: refusing to publish images carrying secrets" >&2
  exit 65
fi
echo "check-image-secrets: no secrets found in any shipped image"
