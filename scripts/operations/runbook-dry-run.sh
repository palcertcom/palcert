#!/usr/bin/env bash
# Operator runbook dry-run (Phase 20 Checkpoint 8).
#
#   PROJECT=palcert-c7 RELEASE_ENV=… bash scripts/operations/runbook-dry-run.sh
#
# The rule this enforces: **an operator following the documentation, with only
# the inputs the documentation names, must be able to do the thing.** Anything
# that needs a value nobody wrote down, a command that only exists in
# somebody's shell history, or a step whose output does not match what the page
# says, is a documentation defect — not a note for later.
#
# So every command below is copied from a runbook, and the environment given to
# it is only what that runbook says to supply. Where a command cannot be run
# here (it would promote to a real registry, or destroy a production data
# plane) the dry-run checks the *instructions* instead: that the command
# exists, that its required inputs are documented, and that it refuses cleanly
# when they are missing.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${PROJECT:-palcert-c7}"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

failures=0
say() {
  printf 'runbook: %-4s %-58s %s\n' "$1" "$2" "${3:-}"
  [ "$1" = FAIL ] && failures=$((failures + 1)) || true
}

doc() { echo "$REPO/docs/operations/$1"; }

# A runbook must *name* the command, or an operator cannot find it.
documented() { # file needle label
  if grep -qF -- "$2" "$(doc "$1")" 2>/dev/null; then
    say ok "$3" "documented in $1"
  else
    say FAIL "$3" "not documented in $1 — tribal knowledge"
  fi
}

# A script an operator is told to run must exist and must refuse clearly when
# its documented inputs are absent. "Refuses clearly" is the point: a command
# that exits 1 saying nothing sends the operator to the source, which is
# exactly the tribal knowledge this is looking for.
refuses_cleanly() { # script label
  local path="$REPO/$1"
  if [ ! -f "$path" ]; then
    say FAIL "$2" "$1 does not exist"
    return
  fi
  local output status
  output="$(env -i PATH="$PATH" HOME="$HOME" bash "$path" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then
    say FAIL "$2" "ran with no inputs at all and reported success"
  elif printf '%s' "$output" | grep -qiE 'required|must be|is needed|usage'; then
    say ok "$2" "refuses and names what it needs (exit $status)"
  else
    say FAIL "$2" "refused (exit $status) without saying what it needs"
  fi
}

# The runbooks give operators `pnpm --filter <package> <script>` commands. A
# command a runbook names must actually be a script in that package, or the
# operator's first step fails.
package_script_exists() { # package script label
  local manifest
  case "$1" in
    @palcert/api) manifest="$REPO/apps/api/package.json" ;;
    @palcert/database) manifest="$REPO/packages/database/package.json" ;;
    @palcert/web) manifest="$REPO/apps/web/package.json" ;;
    *) manifest="" ;;
  esac
  if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then
    say FAIL "$3" "no package manifest for $1"
    return
  fi
  if node -e "process.exit(JSON.parse(require('fs').readFileSync('$manifest','utf8')).scripts?.['$2'] ? 0 : 1)"; then
    say ok "$3" "pnpm --filter $1 $2"
  else
    say FAIL "$3" "the runbook names \`$2\` but $1 has no such script"
  fi
}

echo "runbook: project=$PROJECT out=$OUT"

# ---------------------------------------------------------------------------
# 1. Release lookup: which release is running, and what is it made of?
# ---------------------------------------------------------------------------
echo "runbook: 1/7 release lookup"
ready="$(docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
  -s --max-time 10 http://api:4000/health/ready 2>/dev/null)"
if printf '%s' "$ready" | grep -q '"commit"'; then
  commit="$(printf '%s' "$ready" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')"
  say ok 'the running release identifies its commit' "${commit:0:12}"
else
  say FAIL 'the running release identifies its commit' 'no commit in the readiness response'
fi
documented release-delivery.md 'health/ready' 'the runbook says where to read the running release'
documented release-delivery.md 'verify-manifest' 'the runbook names the manifest verifier'

# ---------------------------------------------------------------------------
# 2. Staging promotion instructions.
# ---------------------------------------------------------------------------
echo "runbook: 2/7 staging promotion"
documented release-delivery.md 'scripts/release/deploy.sh' 'staging promotion names the deploy script'
documented release-delivery.md 'digest' 'staging promotion promotes by digest, and says so'
refuses_cleanly scripts/release/deploy.sh 'the deploy script refuses without its documented inputs'

# ---------------------------------------------------------------------------
# 3. Rollback instructions.
# ---------------------------------------------------------------------------
echo "runbook: 3/7 rollback"
documented release-delivery.md 'Rolling the application back' 'a rollback section exists'
documented release-delivery.md 'Rollback refused because of the database' 'the database-refusal case is documented'
refuses_cleanly scripts/release/rollback-rehearsal.sh 'the rollback rehearsal refuses without inputs'

# ---------------------------------------------------------------------------
# 4. Migration-failure response.
# ---------------------------------------------------------------------------
echo "runbook: 4/7 migration failure"
documented release-delivery.md 'migration-preflight' 'the migration preflight is documented'
refuses_cleanly scripts/release/migration-preflight.sh 'the migration preflight refuses without inputs'

# The gate an operator actually reads. Exit codes are part of the contract, so
# the runbook has to say what they mean.
for code in 3 4 6; do
  if grep -qE "exit ?(code )?$code|\\b$code\\b" "$(doc release-delivery.md)" \
    || grep -qE "\\b$code\\b" "$(doc deployment.md)"; then
    say ok "migration-check exit $code is explained somewhere an operator looks"
  else
    say FAIL "migration-check exit $code is explained somewhere an operator looks"
  fi
done

# ---------------------------------------------------------------------------
# 5. Backup, using only the documented command.
# ---------------------------------------------------------------------------
echo "runbook: 5/7 backup"
documented backup.md 'pnpm --filter @palcert/api backup' 'the backup runbook gives a runnable command'
package_script_exists @palcert/api backup 'the backup command exists'
package_script_exists @palcert/api backup:verify 'the backup verification command exists'
package_script_exists @palcert/database provision-backup-role 'the backup-role provisioning command exists'
package_script_exists @palcert/database verify-backup-role 'the backup-role verification command exists'
documented backup.md '--out' 'the backup runbook names the output argument'

# ---------------------------------------------------------------------------
# 6. Restore into a disposable environment.
# ---------------------------------------------------------------------------
echo "runbook: 6/7 restore"
documented restore.md 'pnpm --filter @palcert/api restore' 'the restore runbook gives a runnable command'
package_script_exists @palcert/api restore 'the restore command exists'
package_script_exists @palcert/api restore:verify 'the restore verification command exists'
package_script_exists @palcert/api storage:provision 'the storage provisioning command exists'
package_script_exists @palcert/database migrations:check 'the migration check command exists'
documented restore.md 'order' 'the restore runbook states the recovery order'
documented restore.md 'RESTORE_DATABASE_ADMIN_URL' 'the restore runbook names the destination it needs'

# ---------------------------------------------------------------------------
# 7. Metrics and alert lookup.
# ---------------------------------------------------------------------------
echo "runbook: 7/7 metrics and alerts"
metrics="$(docker run --rm --network "${PROJECT}_edge" curlimages/curl:8.11.1 \
  -s --max-time 10 http://api:4000/metrics 2>/dev/null)"
# A here-string, not a pipe: under pipefail, `grep -q` exiting at its first
# match kills the writer with SIGPIPE once the exposition outgrows the pipe
# buffer, and a readable endpoint is reported as unreadable (Checkpoint 20.9).
if grep -q '^palcert_' <<< "$metrics"; then
  say ok 'metrics are readable where the runbook says they are' \
    "$(printf '%s' "$metrics" | grep -c '^palcert_') series"
else
  say FAIL 'metrics are readable where the runbook says they are'
fi
documented observability.md 'metrics' 'the observability runbook says where to scrape'
documented alerting.md 'palcert.rules.yml' 'the alerting runbook names the rule file'

# An alert an operator is paged by must be findable in the rule file by name.
rules="$REPO/ops/alerts/palcert.rules.yml"
if [ -f "$rules" ]; then
  named="$(grep -c 'alert:' "$rules")"
  documented_alerts=0
  while IFS= read -r alert; do
    grep -qF -- "$alert" "$(doc alerting.md)" && documented_alerts=$((documented_alerts + 1))
  done < <(grep 'alert:' "$rules" | sed 's/.*alert: *//' | tr -d '"')
  if [ "$documented_alerts" -eq "$named" ]; then
    say ok 'every alert in the rule file is explained in the runbook' "$named alert(s)"
  else
    say FAIL 'every alert in the rule file is explained in the runbook' \
      "$documented_alerts of $named explained"
  fi
else
  say FAIL 'the alert rule file exists' "$rules not found"
fi

if [ "$failures" -ne 0 ]; then
  echo "runbook: $failures documentation defect(s); output in $OUT" >&2
  exit 65
fi
echo "runbook: every step is doable from the documentation alone"
