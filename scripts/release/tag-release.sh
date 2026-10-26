#!/usr/bin/env bash
# Add the human-readable release tag to images that already exist by digest
# (Phase 20 Checkpoint 5).
#
#   ./tag-release.sh release-manifest.json
#
# Deliberately a separate step, after the manifest is written and verified.
# A tag is a label pointing at an artifact; the artifact is the digest. Tagging
# last means a tag can only ever name bytes that were already published and
# already recorded — a tag can never be the first thing that exists.
#
# Uses `buildx imagetools create`, which copies the manifest inside the
# registry rather than pulling and re-pushing. The bytes cannot change, so the
# digest cannot change.
set -euo pipefail

MANIFEST="${1:-release-manifest.json}"
[ -f "$MANIFEST" ] || { echo "tag-release: $MANIFEST not found" >&2; exit 65; }

registry=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['registry'])")
tag=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['releaseTag'])")

python3 -c "
import json
m = json.load(open('$MANIFEST'))
for name, image in sorted(m['images'].items()):
    print(f\"{name} {image['repository']} {image['digest']}\")
" | while read -r name repository digest; do
  source="$registry/$repository@$digest"
  target="$registry/$repository:$tag"
  echo "tag-release: $name -> :$tag"
  docker buildx imagetools create --tag "$target" "$source"

  # Prove the tag resolves to the digest the manifest recorded. Without this
  # the tag is an assertion; with it, it is a fact.
  #
  # Read as JSON. buildx renders any template beginning `{{.Manifest` as its
  # human-readable listing instead of evaluating it, so `{{.Manifest.Digest}}`
  # returned the listing and this comparison failed for every image of every
  # release (found in Checkpoint 20.9; test-tag-release.sh).
  resolved=$(docker buildx imagetools inspect "$target" --format '{{json .Manifest}}' \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["digest"])')
  if [ "$resolved" != "$digest" ]; then
    echo "tag-release:   $target resolves to $resolved, expected $digest" >&2
    exit 65
  fi
  echo "tag-release:   $target -> $resolved"
done

echo "tag-release: every image tagged $tag and verified against its digest"
