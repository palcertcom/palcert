#!/usr/bin/env bash
# Verify each release image carries a build provenance attestation
# (Phase 20 Checkpoint 5).
#
#   ./verify-provenance.sh release-manifest.json
#
# Read from the registry, beside the image, as an OCI referrer. That choice is
# the point: provenance is an in-toto statement attached to the image index, so
# any registry and any consumer can read it. Nothing in PalCert has to call a
# vendor's signing service to deploy, and no such service can become a runtime
# dependency of a deployment by accident.
#
# This proves the attestation exists and says what kind of statement it is. It
# is deliberately not a signature verification: that requires a trust root and
# a key distribution story, which PalCert does not yet have and should not
# pretend to. Saying "provenance present" is true; saying "provenance verified"
# without a trust root would not be.
set -euo pipefail

MANIFEST="${1:?release manifest required}"
PREDICATE="${PROVENANCE_PREDICATE:-https://slsa.dev/provenance/v1}"

failed=0
say() { printf 'verify-provenance: %-4s %s — %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && failed=1 || true; }

while IFS=' ' read -r component reference; do
  [ -z "$component" ] && continue

  index=$(docker buildx imagetools inspect "$reference" --raw 2>/dev/null || true)
  if [ -z "$index" ]; then
    say FAIL "$component" "cannot read the image index from the registry"
    continue
  fi

  # The attestation manifest is a sibling entry in the index, marked by
  # BuildKit with a reference type and pointing back at the platform image.
  attestation=$(printf '%s' "$index" | python3 -c "
import json, sys
try:
    index = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for descriptor in index.get('manifests', []):
    annotations = descriptor.get('annotations') or {}
    if annotations.get('vnd.docker.reference.type') == 'attestation-manifest':
        print(descriptor['digest'])
        break
")
  if [ -z "$attestation" ]; then
    say FAIL "$component" "no attestation attached to the image index"
    continue
  fi

  repository="${reference%@*}"
  predicates=$(docker buildx imagetools inspect "$repository@$attestation" --raw 2>/dev/null \
    | python3 -c "
import json, sys
try:
    manifest = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for layer in manifest.get('layers', []):
    predicate = (layer.get('annotations') or {}).get('in-toto.io/predicate-type')
    if predicate:
        print(predicate)
" || true)

  if printf '%s' "$predicates" | grep -qF "$PREDICATE"; then
    say ok "$component" "$PREDICATE"
  else
    say FAIL "$component" "attestation present but no $PREDICATE statement"
  fi
done < <(python3 -c "
import json, sys
manifest = json.load(open('$MANIFEST'))
for component, image in manifest['images'].items():
    print(component, f\"{manifest['registry']}/{image['repository']}@{image['digest']}\")
")

if [ "$failed" -ne 0 ]; then
  echo "verify-provenance: the release cannot prove how its images were built" >&2
  exit 65
fi
echo "verify-provenance: every image carries a $PREDICATE attestation"
