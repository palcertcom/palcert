#!/usr/bin/env bash
# Vulnerability scan against the images PalCert is about to ship
# (Phase 20 Checkpoint 5).
#
#   IMAGE_REFS="ghcr.io/…@sha256:… …" ./scan-images.sh
#
# Against the runtime images rather than the source dependency graph, because
# they answer different questions. `pnpm audit` and `pip-audit` — which CI
# already runs — tell you about the dependencies the build declared. This tells
# you about the operating-system packages, the base image and everything else
# that is actually in the layers a server will run.
#
# Fails the release on HIGH or CRITICAL. Anything lower is reported and does
# not block: a release process that stops for every low-severity advisory is a
# release process that gets switched off.
set -euo pipefail

SCAN_DIR="${SCAN_DIR:-scan}"
FAIL_ON="${FAIL_ON:-high}"
mkdir -p "$SCAN_DIR"

if [ -z "${IMAGE_REFS:-}" ]; then
  echo "scan-images: IMAGE_REFS is required (one reference per line)" >&2
  exit 78
fi

if ! command -v trivy > /dev/null 2>&1; then
  echo "scan-images: installing trivy"
  curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
    | sh -s -- -b /usr/local/bin > /dev/null
fi

failed=0
while IFS= read -r reference; do
  [ -z "${reference// }" ] && continue
  name=$(basename "${reference%@*}")
  report="$SCAN_DIR/$name.json"
  echo "scan-images: $name"
  # The report is written whether or not the scan passes: a release that was
  # blocked still needs its evidence.
  trivy image --quiet --format json --output "$report" "$reference" || true
  trivy image --quiet --severity HIGH,CRITICAL --exit-code 1 --ignore-unfixed "$reference" \
    || { echo "scan-images:   HIGH/CRITICAL findings in $name" >&2; failed=1; }
done <<< "$IMAGE_REFS"

if [ "$failed" -ne 0 ]; then
  echo "scan-images: refusing to publish a release with unpatched high-severity findings" >&2
  exit 65
fi
echo "scan-images: no fixable HIGH or CRITICAL findings"
