#!/usr/bin/env bash
# Retrieve the manifest for a release that was already built
# (Phase 20 Checkpoint 5).
#
#   ./fetch-manifest.sh 0.1.0+abc1234 release-manifest.json
#
# A deployment never produces a manifest; it consumes one. Which release is
# being deployed is an input, and the manifest for it already exists — that is
# what makes promotion and rollback the same operation with a different
# argument, and what lets a recovery redeploy a known-good release without
# any old commit being buildable.
#
# Two sources, in order of durability:
#   1. the release record committed in the repository, which survives anything
#      the registry or the CI provider does;
#   2. the workflow-run artifact, for a candidate not yet recorded.
set -euo pipefail

VERSION="${1:?release version required, e.g. 0.1.0+abc1234}"
OUT="${2:-release-manifest.json}"
RECORDS="${RELEASE_RECORDS_DIR:-docs/releases}"
# The freeze record travels with the manifest. A deployment needs both: the
# manifest says what the release is, and the freeze says that this exact
# manifest was accepted, with the supply-chain evidence gathered against it.
FREEZE_OUT="${FREEZE_OUT:-release-freeze.json}"

tag="${VERSION/+/-}"
committed="$RECORDS/$tag.json"

committed_freeze="$RECORDS/$tag.freeze.json"

if [ -f "$committed" ]; then
  cp "$committed" "$OUT"
  [ -f "$committed_freeze" ] && cp "$committed_freeze" "$FREEZE_OUT"
  echo "fetch-manifest: $VERSION from the committed release record"
elif command -v gh > /dev/null 2>&1; then
  echo "fetch-manifest: $VERSION not in $RECORDS; asking the workflow artifacts"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  gh run download --name "release-$VERSION" --dir "$work" \
    || { echo "fetch-manifest: no artifact named release-$VERSION" >&2; exit 65; }
  cp "$work/release-manifest.json" "$OUT"
  [ -f "$work/release-freeze.json" ] && cp "$work/release-freeze.json" "$FREEZE_OUT"
  echo "fetch-manifest: $VERSION from a workflow artifact"
else
  echo "fetch-manifest: $VERSION has no committed record and gh is unavailable" >&2
  exit 65
fi

# Whatever the source, the file must be a manifest for the release asked for.
actual=$(python3 -c "import json;print(json.load(open('$OUT'))['releaseVersion'])")
if [ "$actual" != "$VERSION" ]; then
  echo "fetch-manifest: asked for $VERSION but the record says $actual" >&2
  exit 65
fi
# A manifest with no freeze record is a release nobody accepted. Rather than
# fail here — a recovery may legitimately predate the freeze record — say so
# plainly, and let the promotion boundary refuse if one is required.
if [ -f "$FREEZE_OUT" ]; then
  echo "fetch-manifest: $VERSION -> $OUT (+ $FREEZE_OUT)"
else
  echo "fetch-manifest: $VERSION -> $OUT (no freeze record found)" >&2
fi
