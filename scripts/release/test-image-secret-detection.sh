#!/usr/bin/env bash
# Prove that check-image-secrets.sh can fail (Phase 20 Checkpoint 5).
#
#   bash scripts/release/test-image-secret-detection.sh
#
# A secret scanner that has only ever reported "clean" is indistinguishable
# from one that reports "clean" unconditionally, and PalCert's images are in
# fact clean — so passing it tells us nothing on its own. This plants each of
# the two leaks it is meant to catch, in a throwaway image built on the real
# one, and requires a refusal for each.
#
# Nothing here is a real credential. The planted values are the same
# development placeholders the scanner already knows, which is precisely why
# they are the right bait: if a build ever copied a local .env into a layer,
# these are the strings that would be in it.
set -euo pipefail

BASE="${BASE_IMAGE:-}"
if [ -z "$BASE" ]; then
  echo "test-image-secret-detection: BASE_IMAGE is required" >&2
  exit 78
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; docker rmi -f palcert-secret-probe:config palcert-secret-probe:layer > /dev/null 2>&1 || true' EXIT

failures=0

expect_refusal() {
  local label="$1" image="$2"
  if IMAGE_REFS="$image" bash "$HERE/check-image-secrets.sh" > "$WORK/out.txt" 2>&1; then
    echo "  FAIL $label: the scanner reported this image clean" >&2
    sed 's/^/        /' "$WORK/out.txt" >&2
    failures=$((failures + 1))
  else
    echo "  ok   $label: refused"
  fi
}

expect_pass() {
  local label="$1" image="$2"
  if IMAGE_REFS="$image" bash "$HERE/check-image-secrets.sh" > "$WORK/out.txt" 2>&1; then
    echo "  ok   $label: accepted"
  else
    echo "  FAIL $label: the scanner refused an image with nothing planted in it" >&2
    sed 's/^/        /' "$WORK/out.txt" >&2
    failures=$((failures + 1))
  fi
}

echo "test-image-secret-detection: base $BASE"

# 1. A secret passed as a build argument and captured into the image's own
#    configuration, where `docker inspect` shows it to anyone who can pull.
printf 'FROM %s\nENV DATABASE_URL="postgresql://palcert:palcert_local_dev@db:5432/palcert"\n' "$BASE" \
  > "$WORK/config.Dockerfile"
docker build -q -f "$WORK/config.Dockerfile" -t palcert-secret-probe:config "$WORK" > /dev/null
expect_refusal 'a credential in the image configuration' palcert-secret-probe:config

# 2. A fixture credential copied into a layer, where configuration inspection
#    cannot see it at all and only reading the filesystem will.
printf 'STORAGE_SECRET_ACCESS_KEY=test-secret-key\n' > "$WORK/.env"
printf 'FROM %s\nUSER root\nCOPY .env /app/.env\n' "$BASE" > "$WORK/layer.Dockerfile"
docker build -q -f "$WORK/layer.Dockerfile" -t palcert-secret-probe:layer "$WORK" > /dev/null
expect_refusal 'a fixture credential in a layer' palcert-secret-probe:layer

# 3. The control. Without this the two refusals above would also be satisfied
#    by a scanner that refuses everything.
expect_pass 'the unmodified image' "$BASE"

if [ "$failures" -ne 0 ]; then
  echo "test-image-secret-detection: $failures check(s) failed — the secret scan cannot be trusted" >&2
  exit 65
fi
echo "test-image-secret-detection: the secret scan detects both leak shapes and passes a clean image"
