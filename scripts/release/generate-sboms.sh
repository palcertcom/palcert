#!/usr/bin/env bash
# A software bill of materials for every image PalCert ships
# (Phase 20 Checkpoint 5).
#
#   IMAGE_REFS="api=ghcr.io/…@sha256:… worker=…" SBOM_DIR=sbom ./generate-sboms.sh
#
# Generated from the *image*, not from the source dependency graph. Those are
# different lists: the graph says what the build declared, the image says what
# actually shipped -- base-image packages, transitive runtime libraries, and
# anything a Dockerfile installed that no manifest mentions.
#
# SPDX because it is an ISO standard and every consumer reads it; the format
# matters more than the tool, and nothing downstream depends on which scanner
# produced it.
set -euo pipefail

SBOM_DIR="${SBOM_DIR:-sbom}"
mkdir -p "$SBOM_DIR"

if [ -z "${IMAGE_REFS:-}" ]; then
  echo "generate-sboms: IMAGE_REFS is required (name=reference per line)" >&2
  exit 78
fi

if ! command -v syft > /dev/null 2>&1; then
  echo "generate-sboms: installing syft"
  curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh \
    | sh -s -- -b /usr/local/bin > /dev/null
fi

count=0
while IFS= read -r line; do
  [ -z "${line// }" ] && continue
  name="${line%%=*}"
  reference="${line#*=}"
  output="$SBOM_DIR/palcert-$name.spdx.json"
  echo "generate-sboms: $name"
  syft scan "$reference" -o spdx-json="$output" --quiet
  # An SBOM that lists nothing is worse than none: it looks like evidence.
  packages=$(python3 -c "import json,sys; print(len(json.load(open('$output')).get('packages', [])))")
  if [ "$packages" -lt 10 ]; then
    echo "generate-sboms: $name lists only $packages package(s) — refusing to call that an SBOM" >&2
    exit 65
  fi
  echo "generate-sboms:   $packages packages -> $output"
  count=$((count + 1))
done <<< "$IMAGE_REFS"

echo "generate-sboms: $count SBOM(s) in $SBOM_DIR"
