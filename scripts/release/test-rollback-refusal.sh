#!/usr/bin/env bash
# Prove an unsafe rollback is refused (Phase 20 Checkpoint 5).
#
#   FREEZE_B=release-freeze.json bash scripts/release/test-rollback-refusal.sh
#
# The A -> B -> A rehearsal exercises the permitted case: both releases expect
# the same schema, so rolling the application back leaves nothing behind. That
# is the easy half, and on its own it proves only that the gate says yes.
#
# This is the other half. A release that predates migrations the database has
# since applied is being asked to run against a schema it has never seen, and
# the gate must refuse rather than guess — PalCert does not generate reverse
# migrations, so "roll back" cannot mean "undo the schema".
#
# The target manifests below are fixtures, and are labelled as such. They
# describe real migration states taken from this repository's own history, but
# they are not releases: no images were built for them and nothing is deployed
# from them. Only the schema expectation is under test, which is the only
# input the gate reads on this path.
set -euo pipefail

FREEZE_B="${FREEZE_B:?the current release freeze record is required}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CURRENT="$(python3 -c "import json,os,sys; f=sys.argv[1]; print(os.path.join(os.path.dirname(f), json.load(open(f))['manifest']['file']))" "$FREEZE_B")"

failures=0
expect() { # label expected-exit target-manifest [extra args...]
  local label="$1" expected="$2" target="$3"; shift 3
  local actual=0
  node "$HERE/check-rollback-safety.mjs" --from "$CURRENT" --to "$target" "$@" \
    > "$WORK/out.txt" 2>&1 || actual=$?
  if [ "$actual" = "$expected" ]; then
    echo "  ok   $label (exit $actual)"
  else
    echo "  FAIL $label: exit $actual, expected $expected" >&2
    sed 's/^/        /' "$WORK/out.txt" >&2
    failures=$((failures + 1))
  fi
}

# Build a fixture target that expects `n` fewer migrations than the current
# release, with a head name taken from the real migration list so the message
# an operator reads names a migration that exists.
fixture() { # fewer-migrations output
  python3 - "$CURRENT" "$1" "$2" <<'PY'
import hashlib, json, os, sys
current = json.load(open(sys.argv[1]))
fewer = int(sys.argv[2])
target = json.loads(json.dumps(current))

migrations = sorted(
    entry for entry in os.listdir('packages/database/prisma/migrations')
    if os.path.isdir(os.path.join('packages/database/prisma/migrations', entry))
)
kept = migrations[: len(migrations) - fewer]

target['releaseVersion'] = f'0.0.1+fixture{fewer}'
target['releaseTag'] = f'0.0.1-fixture{fewer}'
target['migration'] = {
    'count': len(kept),
    'head': kept[-1],
    'checksum': hashlib.sha256('\n'.join(kept).encode()).hexdigest(),
}
with open(sys.argv[3], 'w') as handle:
    json.dump(target, handle, indent=2, sort_keys=True)
PY
}

echo "test-rollback-refusal: current $(python3 -c "import json;print(json.load(open('$FREEZE_B'))['releaseVersion'])")"

# The control: rolling back to something that expects the same schema is the
# permitted case, and it must stay permitted.
python3 - "$CURRENT" "$WORK/same-schema.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest['releaseVersion'] = '0.0.1+samefixture'
manifest['releaseTag'] = '0.0.1-samefixture'
json.dump(manifest, open(sys.argv[2], 'w'), indent=2, sort_keys=True)
PY
expect 'a target expecting the same schema' 0 "$WORK/same-schema.json"

# One migration behind. The most common real rollback, and the one most
# likely to be waved through because "it is only one".
fixture 1 "$WORK/behind-1.json"
expect 'a target one migration behind' 3 "$WORK/behind-1.json"

# Several behind, which is what rolling back past a release train looks like.
fixture 5 "$WORK/behind-5.json"
expect 'a target five migrations behind' 3 "$WORK/behind-5.json"

# The operator override. Deliberately long to type, because it is a signed
# statement that someone read the migrations in the gap and decided the older
# release tolerates them — not a way to retry the command.
expect 'an operator who has confirmed compatibility' 0 "$WORK/behind-1.json" \
  --i-have-confirmed-schema-compatibility

# Forward, not back. Whatever this is, it is not a rollback, and it must not
# be reported as an unsafe one: the operator would reach for the override.
python3 - "$CURRENT" "$WORK/ahead.json" <<'PY'
import hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
manifest['releaseVersion'] = '0.0.2+aheadfixture'
manifest['releaseTag'] = '0.0.2-aheadfixture'
names = [f'2027{index:010d}_fixture' for index in range(manifest['migration']['count'] + 3)]
manifest['migration'] = {
    'count': len(names),
    'head': names[-1],
    'checksum': hashlib.sha256('\n'.join(names).encode()).hexdigest(),
}
json.dump(manifest, open(sys.argv[2], 'w'), indent=2, sort_keys=True)
PY
expect 'a target that expects MORE migrations' 65 "$WORK/ahead.json"

# Rolling back to the release already running is a mistake worth naming
# rather than a no-op to perform.
expect 'a target identical to what is running' 64 "$CURRENT"

if [ "$failures" -ne 0 ]; then
  echo "test-rollback-refusal: $failures case(s) failed — the rollback gate is not trustworthy" >&2
  exit 65
fi
echo "test-rollback-refusal: unsafe rollbacks refused, safe ones permitted, no reverse migration invented"
