#!/usr/bin/env bash
# Prove a substituted image cannot be promoted (Phase 20 Checkpoint 5).
#
#   FREEZE=release-freeze.json bash scripts/release/test-substitution-refused.sh
#
# The release model's central claim is that what staging accepted and what
# production runs are the same bytes. That claim rests entirely on the
# deployment configuration naming digests from the freeze record and nothing
# else, which means the check that enforces it has to be shown refusing — not
# merely shown passing against configuration that was already correct.
#
# Each case below is a way the claim could be broken in practice: someone
# renders from a tag because it is easier to read, a workflow re-resolves a
# tag that has since moved, a single image is swapped while four stay frozen,
# or a manifest from a different release is used. None of them look wrong in
# a diff, and all of them produce a system that was never tested.
set -euo pipefail

FREEZE="${FREEZE:?release freeze record required}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

assert() { # label expectation env-file
  local label="$1" expectation="$2" file="$3"
  if node "$HERE/assert-frozen-images.mjs" --freeze "$FREEZE" --images-env "$file" \
      > "$WORK/out.txt" 2>&1; then
    local outcome=accepted
  else
    local outcome=refused
  fi
  if [ "$outcome" = "$expectation" ]; then
    echo "  ok   $label: $outcome"
  else
    echo "  FAIL $label: $outcome (expected $expectation)" >&2
    sed 's/^/        /' "$WORK/out.txt" >&2
    failures=$((failures + 1))
  fi
}

echo "test-substitution-refused: freeze $(python3 -c "import json;print(json.load(open('$FREEZE'))['releaseVersion'])")"

# The honest rendering, from the frozen manifest. Everything below is this
# file with one thing changed, so each case isolates exactly one substitution.
MANIFEST="$(dirname "$FREEZE")/$(python3 -c "import json;print(json.load(open('$FREEZE'))['manifest']['file'])")"
node "$HERE/render-deploy-env.mjs" --manifest "$MANIFEST" --out "$WORK/good.env" > /dev/null

# 0. The control. Without it, a check that refuses everything would pass all
#    the cases below.
assert 'the honest rendering' accepted "$WORK/good.env"

# 1. A tag where a digest belongs. The most likely mistake, because it works:
#    the deployment starts, the service runs, and nothing reports a problem
#    until the tag is moved and a redeploy silently changes the bytes.
sed 's|^API_IMAGE=\(.*\)@sha256:.*|API_IMAGE=\1:0.1.0-18d07c5|' "$WORK/good.env" > "$WORK/tag.env"
assert 'a tag substituted for the API digest' refused "$WORK/tag.env"

# 2. A different real digest. This is the case a tag comparison cannot catch
#    at all: the reference is still digest-addressed and still resolves.
OTHER='sha256:0000000000000000000000000000000000000000000000000000000000000000'
sed "s|^WEB_IMAGE=\(.*\)@sha256:.*|WEB_IMAGE=\1@$OTHER|" "$WORK/good.env" > "$WORK/swapped.env"
assert 'one image swapped, four still frozen' refused "$WORK/swapped.env"

# 3. An image missing entirely. A release is five images; four is not a
#    smaller release, it is a different system.
grep -v '^ENGINE_IMAGE=' "$WORK/good.env" > "$WORK/missing.env"
assert 'the document engine image absent' refused "$WORK/missing.env"

# 4. Correct digests, wrong release identity. The images would run, and the
#    deployment record would name a release that was never deployed.
sed 's|^RELEASE_COMMIT=.*|RELEASE_COMMIT=0000000000000000000000000000000000000000|' \
  "$WORK/good.env" > "$WORK/commit.env"
assert 'the digests frozen but the commit rewritten' refused "$WORK/commit.env"

if [ "$failures" -ne 0 ]; then
  echo "test-substitution-refused: $failures case(s) failed — promotion by digest is not enforced" >&2
  exit 65
fi
echo "test-substitution-refused: every substitution refused, the honest rendering accepted"
