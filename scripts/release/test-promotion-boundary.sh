#!/usr/bin/env bash
# Prove the production promotion boundary refuses (Phase 20 Checkpoint 5).
#
#   FREEZE=release-freeze.json STAGING_RECORD=staging-deployment.json \
#     bash scripts/release/test-promotion-boundary.sh
#
# Checkpoint 20.5 has already shown twice that a gate which has only ever
# reported success may not be a gate at all — the image secret scan could not
# fail, and a smoke check "passed" against a URL the API does not serve. The
# production boundary is the one place where that mistake is most expensive,
# and the hardest to notice, because nobody tests it by dispatching a real
# production deployment from a feature branch to see what happens.
#
# So each way a release could reach production without a decision is tried
# here, and each must be refused with its own exit code.
set -euo pipefail

FREEZE="${FREEZE:?release freeze record required}"
STAGING_RECORD="${STAGING_RECORD:?staging deployment record required}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

run() { node "$HERE/check-promotion-allowed.mjs" "$@" > "$WORK/out.txt" 2>&1; }

expect() { # label expected-exit args...
  local label="$1" expected="$2"; shift 2
  local actual=0
  run "$@" || actual=$?
  if [ "$actual" = "$expected" ]; then
    echo "  ok   $label (exit $actual)"
  else
    echo "  FAIL $label: exit $actual, expected $expected" >&2
    sed 's/^/        /' "$WORK/out.txt" >&2
    failures=$((failures + 1))
  fi
}

GOOD=(--environment production --ref refs/heads/main --reason 'Checkpoint 20.5 rehearsal'
      --approved-by release-approver --freeze "$FREEZE" --staging-record "$STAGING_RECORD")

echo "test-promotion-boundary: $(python3 -c "import json;print(json.load(open('$FREEZE'))['releaseVersion'])")"

# The control. Every refusal below is only meaningful against a case that is
# allowed, otherwise refusing everything would score full marks.
expect 'a fully authorised production promotion' 0 "${GOOD[@]}"

# Staging deliberately has no approval boundary, and that has to stay true:
# a staging gate that demanded approval would mean nobody could find out
# whether a release works until someone signed for it.
expect 'staging needs no approval' 0 --environment staging --freeze "$FREEZE"

# 3 — the ref. The workflow file is read from the ref it was dispatched on, so
# an arbitrary branch could otherwise carry its own deployment steps.
expect 'promotion from a feature branch' 3 \
  --environment production --ref refs/heads/claude/some-branch \
  --reason 'why not' --approved-by someone \
  --freeze "$FREEZE" --staging-record "$STAGING_RECORD"

expect 'promotion from a pull request ref' 3 \
  --environment production --ref refs/pull/42/merge \
  --reason 'why not' --approved-by someone \
  --freeze "$FREEZE" --staging-record "$STAGING_RECORD"

# 4 — no named human. An automated production deployment with nobody
# accountable for it is the thing the approval boundary exists to prevent.
expect 'promotion with no approver' 4 \
  --environment production --ref refs/heads/main --reason 'urgent' \
  --approved-by '' --freeze "$FREEZE" --staging-record "$STAGING_RECORD"

# 5 — no reason. Cheap to require, and the only question anyone asks later.
expect 'promotion with no stated reason' 5 \
  --environment production --ref refs/heads/main --reason '   ' \
  --approved-by release-approver --freeze "$FREEZE" --staging-record "$STAGING_RECORD"

# 6 — the staging evidence. Four distinct ways it can fail to establish that
# these bytes were the bytes staging accepted.
expect 'promotion with no staging record at all' 6 \
  --environment production --ref refs/heads/main --reason 'ship it' \
  --approved-by release-approver --freeze "$FREEZE"

python3 - "$STAGING_RECORD" "$WORK/failed.json" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
record['outcome'] = 'failure'
json.dump(record, open(sys.argv[2], 'w'))
PY
expect 'promotion after staging failed' 6 \
  --environment production --ref refs/heads/main --reason 'ship it' \
  --approved-by release-approver --freeze "$FREEZE" --staging-record "$WORK/failed.json"

# The case a version-string comparison cannot catch: the record names this
# release, and a different manifest. Same name, different bytes.
python3 - "$STAGING_RECORD" "$WORK/other-manifest.json" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
record['manifestDigest'] = 'sha256:' + '0' * 64
json.dump(record, open(sys.argv[2], 'w'))
PY
expect 'promotion of a manifest staging never saw' 6 \
  --environment production --ref refs/heads/main --reason 'ship it' \
  --approved-by release-approver --freeze "$FREEZE" --staging-record "$WORK/other-manifest.json"

# And the record that names the right manifest but a different image, which is
# what a partial rebuild between environments would look like.
python3 - "$STAGING_RECORD" "$WORK/swapped-image.json" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
reference = record['images']['api']
record['images']['api'] = reference.split('@')[0] + '@sha256:' + '1' * 64
json.dump(record, open(sys.argv[2], 'w'))
PY
expect 'promotion where staging ran a different API image' 6 \
  --environment production --ref refs/heads/main --reason 'ship it' \
  --approved-by release-approver --freeze "$FREEZE" --staging-record "$WORK/swapped-image.json"

if [ "$failures" -ne 0 ]; then
  echo "test-promotion-boundary: $failures case(s) failed — the boundary is not enforced" >&2
  exit 65
fi
echo "test-promotion-boundary: every unauthorised promotion refused, authorised ones allowed"
