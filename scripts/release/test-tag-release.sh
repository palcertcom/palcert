#!/usr/bin/env bash
# Prove the release-tag step can pass, and can refuse (Phase 20 Checkpoint 9).
#
#   bash scripts/release/test-tag-release.sh
#
# tag-release.sh has one job beyond copying a manifest: to show that each tag
# it adds resolves to the digest the manifest recorded. Until Checkpoint 20.9
# that check could not pass. It asked buildx for `{{.Manifest.Digest}}`, which
# buildx answers with its human-readable listing, so the comparison failed for
# every image and the release workflow's last step could never succeed. It had
# never run, because release.yml had never run.
#
# This runs the real script against a stand-in `docker` that answers the way
# buildx does, including that quirk, so the check is shown both accepting an
# honest registry and refusing a tag that resolves anywhere else. No registry
# or network is needed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/tags"
cat > "$WORK/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# Stand-in for `docker buildx imagetools create|inspect` against an in-memory
# registry: $SHIM_TAGS/<tag reference, sanitized> holds the digest a tag names.
set -euo pipefail
[ "$1 $2" = "buildx imagetools" ] || { echo "shim: unexpected docker $*" >&2; exit 2; }
key() { printf '%s' "$1" | tr '/:@' '___'; }
case "$3" in
  create)
    # docker buildx imagetools create --tag <target> <source@digest>
    [ "$4" = "--tag" ] || exit 2
    printf '%s' "${6##*@}" > "$SHIM_TAGS/$(key "$5")"
    ;;
  inspect)
    # docker buildx imagetools inspect <target> --format <template>
    target="$4" template="$6"
    digest=$(cat "$SHIM_TAGS/$(key "$target")")
    # A tag that moved after it was written: the case the check exists for.
    if [ -n "${SHIM_MOVE:-}" ] && [[ "$target" == *"/$SHIM_MOVE:"* ]]; then
      digest="sha256:$(printf '%064d' 0)"
    fi
    case "$template" in
      '{{json .Manifest}}')
        printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":1609}\n' \
          "$digest"
        ;;
      '{{.Manifest'*)
        # What buildx really prints for any template starting `{{.Manifest`.
        printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    %s\n' \
          "$target" "$digest"
        ;;
      *) echo "shim: unsupported template $template" >&2; exit 2 ;;
    esac
    ;;
  *) echo "shim: unexpected imagetools $3" >&2; exit 2 ;;
esac
SHIM
chmod +x "$WORK/bin/docker"

python3 - "$WORK/release-manifest.json" <<'EOF'
import json, sys
names = ['api', 'worker', 'migrate', 'web', 'documentEngine']
repositories = ['palcert-api', 'palcert-worker', 'palcert-migrate', 'palcert-web',
                'palcert-document-engine']
manifest = {
    'registry': 'registry.test/owner',
    'releaseTag': '0.1.0-abc1234',
    'images': {
        name: {'repository': repository, 'digest': 'sha256:' + format(index + 1, 'x') * 64}
        for index, (name, repository) in enumerate(zip(names, repositories))
    },
}
json.dump(manifest, open(sys.argv[1], 'w'))
EOF

failures=0
run() { # label expectation [VAR=value ...]
  local label="$1" expectation="$2"
  shift 2
  rm -f "$WORK/tags/"*
  if env PATH="$WORK/bin:$PATH" SHIM_TAGS="$WORK/tags" "$@" \
      bash "$HERE/tag-release.sh" "$WORK/release-manifest.json" > "$WORK/out.txt" 2>&1; then
    local outcome=accepted
  else
    local outcome="refused (exit $?)"
  fi
  if [[ "$outcome" == "$expectation"* ]]; then
    echo "  ok   $label: $outcome"
  else
    echo "  FAIL $label: $outcome (expected $expectation)" >&2
    sed 's/^/        /' "$WORK/out.txt" >&2
    failures=$((failures + 1))
  fi
}

echo "test-tag-release: every tag resolves to its recorded digest"
run 'honest registry' accepted
tagged=$(ls "$WORK/tags" | wc -l)
if [ "$tagged" -ne 5 ]; then
  echo "  FAIL honest registry: $tagged of 5 images tagged" >&2
  failures=$((failures + 1))
fi
echo "test-tag-release: a tag that resolves elsewhere"
run 'the web tag moved' 'refused (exit 65)' SHIM_MOVE=palcert-web
run 'the first image tag moved' 'refused (exit 65)' SHIM_MOVE=palcert-api

if [ "$failures" -gt 0 ]; then
  echo "test-tag-release: $failures case(s) did not behave as required" >&2
  exit 1
fi
echo "test-tag-release: the tag check accepts an honest registry and refuses a moved tag"
