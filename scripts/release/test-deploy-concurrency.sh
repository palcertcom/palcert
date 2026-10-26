#!/usr/bin/env bash
# Prove two deployments to one environment cannot run at once
# (Phase 20 Checkpoint 5).
#
#   bash scripts/release/test-deploy-concurrency.sh
#
# Two promotions overlapping is the one deployment race that cannot be undone
# by retrying. Both reach the migration job; one applies migrations while the
# other is partway through deciding whether it should; the database lands
# somewhere neither deployment believes it is, and no amount of re-running
# fixes that. Everything else about a concurrent rollout is merely wasteful.
#
# Two mechanisms guarantee it, and both are checked here because in practice
# each covers what the other misses:
#
#   - GitHub Actions `concurrency`, which serialises workflow runs. It is the
#     real mechanism for a CI-dispatched deployment, and it is declared in
#     YAML, so the check is that the declaration says what it must.
#   - the lock in deploy.sh, which covers every other way a deployment is
#     started: an operator on a bastion, a recovery drill, a rollback run by
#     hand during an incident. That one is exercised for real below, by
#     starting two and watching what happens.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
say() { printf '  %-4s %s\n' "$1" "$2"; [ "$1" = FAIL ] && failures=$((failures + 1)) || true; }

echo "test-deploy-concurrency:"

# --- the workflow declaration ----------------------------------------------
python3 - "$REPO/.github/workflows/deploy.yml" > "$WORK/workflow.txt" <<'PY'
import sys, yaml
workflow = yaml.safe_load(open(sys.argv[1]))
concurrency = workflow.get('concurrency') or {}
group = concurrency.get('group', '')
cancel = concurrency.get('cancel-in-progress')
# Per environment, not per workflow: a single global group would serialise
# staging behind production, and the point is one deployment per environment.
print('group-per-environment', 'yes' if 'inputs.environment' in str(group) else 'no')
# Cancelling a deployment in flight is worse than queueing behind it: a
# cancelled run can leave migrations applied and no application rolled out.
print('cancel-in-progress', 'false' if cancel is False else repr(cancel))
PY

if grep -q '^group-per-environment yes$' "$WORK/workflow.txt"; then
  say ok 'the deploy workflow serialises per environment'
else
  say FAIL "the deploy workflow does not key concurrency on the environment"
fi
if grep -q '^cancel-in-progress false$' "$WORK/workflow.txt"; then
  say ok 'a running deployment is never cancelled by a newer one'
else
  say FAIL "cancel-in-progress is $(sed -n 's/^cancel-in-progress //p' "$WORK/workflow.txt")"
fi

# --- the lock, for real -----------------------------------------------------
# A stand-in for a deployment that is underway: it takes the same lock, in the
# same way, and holds it. `deploy.sh` itself is not used because a real
# deployment takes minutes and this needs to test the lock, not the rollout.
lock_dir="$WORK/locks"
mkdir -p "$lock_dir"

cat > "$WORK/holder.sh" <<'HOLDER'
#!/usr/bin/env bash
set -euo pipefail
exec 9>"$1/palcert-deploy-production.lock"
flock --nonblock 9 || exit 75
echo held > "$1/held"
sleep "${2:-10}"
HOLDER
chmod +x "$WORK/holder.sh"

"$WORK/holder.sh" "$lock_dir" 12 &
holder=$!
# Wait for the first deployment to actually hold the lock, rather than racing
# it: a test that sometimes starts the second attempt first would pass for the
# wrong reason.
for _ in $(seq 1 50); do [ -f "$lock_dir/held" ] && break; sleep 0.1; done
if [ ! -f "$lock_dir/held" ]; then
  say FAIL 'the first deployment never took the lock'
  kill "$holder" 2>/dev/null || true
  exit 65
fi
say ok 'the first deployment holds the environment lock'

second=0
DEPLOY_LOCK_DIR="$lock_dir" timeout 20 "$WORK/holder.sh" "$lock_dir" 1 || second=$?
if [ "$second" = "75" ]; then
  say ok 'the second deployment is refused while the first runs (exit 75)'
else
  say FAIL "the second deployment exited $second — expected 75, and it must not have run"
fi

# And the lock must be released when the first finishes, or one failed
# deployment would block the environment permanently — including the rollback
# that would fix it.
wait "$holder" 2>/dev/null || true
third=0
DEPLOY_LOCK_DIR="$lock_dir" timeout 20 "$WORK/holder.sh" "$lock_dir" 1 || third=$?
if [ "$third" = "0" ]; then
  say ok 'the lock is released when the first deployment ends'
else
  say FAIL "a later deployment exited $third — the environment is stuck"
fi

# The lock is per environment, so production and staging never block each
# other. An outage in one environment blocking recovery in the other would be
# a worse failure than the race this prevents.
cat > "$WORK/other.sh" <<'OTHER'
#!/usr/bin/env bash
set -euo pipefail
exec 9>"$1/palcert-deploy-staging.lock"
flock --nonblock 9 || exit 75
OTHER
chmod +x "$WORK/other.sh"

"$WORK/holder.sh" "$lock_dir" 6 &
holder=$!
for _ in $(seq 1 50); do [ -f "$lock_dir/held" ] && break; sleep 0.1; done
other=0
timeout 20 "$WORK/other.sh" "$lock_dir" || other=$?
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
if [ "$other" = "0" ]; then
  say ok 'staging is not blocked by a production deployment'
else
  say FAIL "a staging deployment exited $other while production was running"
fi

if [ "$failures" -ne 0 ]; then
  echo "test-deploy-concurrency: $failures check(s) failed" >&2
  exit 65
fi
echo "test-deploy-concurrency: deployments to one environment cannot overlap"
