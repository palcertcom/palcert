#!/usr/bin/env bash
# Persistent local PalCert environment.
#
#   pnpm local:up [--no-build]   build from the working tree and start (keeps data)
#   pnpm local:stop              stop the containers (keeps data)
#   pnpm local:status            containers, volumes and the URL
#   pnpm local:logs [service]    follow logs
#   pnpm local:admin             create or promote a PalCert administrator
#   pnpm local:reset             DELETE all local data (asks for confirmation)
#
# Guarantees, each enforced below rather than documented only:
#   - `up`, `stop`, `status`, `logs` and `admin` never delete data. The data
#     volumes are external to Compose (docker/docker-compose.local.yml), so no
#     Compose command can remove them either.
#   - Only `reset` deletes, and only after the operator types a confirmation
#     phrase at a terminal. It cannot run unattended.
#   - Secrets are generated once into a git-ignored file with owner-only
#     permissions and are never printed.
#   - New secrets are never generated over existing data: a database or
#     encrypted store initialised with one set of secrets is unreadable with
#     another, so if the volumes exist and the secrets file does not, this
#     stops and says so.
#   - Everything is scoped to the Compose project `palcert-local`; no other
#     project, container or volume is touched.
#   - It refuses to run against anything that looks like production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="palcert-local"
ENV_FILE="${PALCERT_LOCAL_ENV_FILE:-$ROOT/.local/palcert-local.env}"
VOLUMES=(
  palcert-local-postgres
  palcert-local-redis
  palcert-local-minio
  palcert-local-clamav
  palcert-local-certs
  palcert-local-kms
)
RESET_PHRASE="delete palcert-local"

say() { printf '%s\n' "$*"; }
die() { printf 'palcert-local: %s\n' "$*" >&2; exit 1; }

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT/docker/docker-compose.release.yml" \
    -f "$ROOT/docker/docker-compose.local.yml" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
}

# A development helper has no business near production. Refuse when the
# caller says it is production, or when the configured public URL is not this
# machine.
refuse_production() {
  case "${NODE_ENV:-}${PALCERT_ENV:-}" in
    *production* | *prod*) die "refusing: NODE_ENV/PALCERT_ENV says production" ;;
  esac
  if [[ -f "$ENV_FILE" ]]; then
    local url
    url="$(grep -E '^APP_PUBLIC_WEB_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
    if [[ -n "$url" && ! "$url" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$ ]]; then
      die "refusing: APP_PUBLIC_WEB_URL in $ENV_FILE is not localhost"
    fi
  fi
}

existing_volumes() {
  local name
  for name in "${VOLUMES[@]}"; do
    if docker volume inspect "$name" >/dev/null 2>&1; then printf '%s\n' "$name"; fi
  done
}

random_b64() { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"; }
random_hex() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-24}).toString('hex'))"; }

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    local mode
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
    [[ "$mode" == "600" ]] || chmod 600 "$ENV_FILE"
    return
  fi
  if [[ -n "$(existing_volumes)" ]]; then
    die "the palcert-local volumes already exist but $ENV_FILE does not.
  They were initialised with other secrets; new ones would lock you out of the
  database and make encrypted data unreadable. Point PALCERT_LOCAL_ENV_FILE at
  the env file you created them with, or run 'pnpm local:reset' to start over."
  fi
  command -v node >/dev/null 2>&1 || die "node is required to generate secrets"
  mkdir -p "$(dirname "$ENV_FILE")"
  (
    umask 077
    {
      echo "# PalCert persistent local environment. Generated once by pnpm local:up."
      echo "# Local development only. Never commit, share or reuse these values."
      echo "POSTGRES_PASSWORD=$(random_hex)"
      echo "POSTGRES_APP_PASSWORD=$(random_hex)"
      echo "STORAGE_ACCESS_KEY_ID=palcert-local-$(random_hex 6)"
      echo "STORAGE_SECRET_ACCESS_KEY=$(random_hex 32)"
      echo "AUTH_MFA_SECRET_KEY=$(random_b64)"
      echo "CERTIFICATE_VERIFICATION_SECRET_KEY=$(random_b64)"
      echo "API_CLIENT_REVEAL_SECRET_KEY=$(random_b64)"
      echo "WEBHOOK_ENCRYPTION_ACTIVE_KID=local-1"
      echo "WEBHOOK_ENCRYPTION_KEYS=local-1:$(random_b64)"
      echo "EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID=local-1"
      echo "EMAIL_SETTINGS_ENCRYPTION_KEYS=local-1:$(random_b64)"
      echo "PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID=local-1"
      echo "PAYOUT_DESTINATION_ENCRYPTION_KEYS=local-1:$(random_b64)"
      echo "# Placeholders: the stack cannot yet boot with payments off (F-024)."
      echo "# No real Stripe account is contacted until real test keys go here."
      echo "STRIPE_SECRET_KEY=sk_test_local_placeholder_$(random_hex 12)"
      echo "STRIPE_WEBHOOK_SECRET=whsec_local_placeholder_$(random_hex 12)"
      echo "PROXY_PORT=8443"
      echo "APP_PUBLIC_WEB_URL=https://localhost:8443"
      echo "API_CORS_ORIGINS=https://localhost:8443"
    } >"$ENV_FILE"
  )
  say "Created $ENV_FILE (owner-only; secrets not shown)."
}

ensure_volumes() {
  local name
  for name in "${VOLUMES[@]}"; do
    if ! docker volume inspect "$name" >/dev/null 2>&1; then
      docker volume create --label palcert.environment=local "$name" >/dev/null
      say "Created volume $name."
    fi
  done
}

url() {
  local port
  port="$(grep -E '^PROXY_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf 'https://localhost:%s\n' "${port:-8443}"
}

cmd_up() {
  local build=1
  for arg in "$@"; do
    case "$arg" in
      --no-build) build=0 ;;
      *) die "unknown option for up: $arg" ;;
    esac
  done
  require_docker
  refuse_production
  ensure_env_file
  refuse_production
  ensure_volumes
  export PALCERT_LOCAL_COMMIT
  PALCERT_LOCAL_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo local)"
  if [[ "$build" == 1 ]]; then
    say "Building images from the working tree ($PALCERT_LOCAL_COMMIT)…"
    compose build
  fi
  # `up` recreates only the containers whose image or configuration changed.
  # The stateful services' volumes are external and are never recreated.
  compose up -d --wait
  say "PalCert is running at $(url)"
}

cmd_stop() {
  require_docker
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE; nothing to stop"
  compose stop
  say "Stopped. Data is kept in: ${VOLUMES[*]}"
}

cmd_status() {
  require_docker
  if [[ -f "$ENV_FILE" ]]; then
    compose ps --all
  else
    say "No $ENV_FILE yet — run 'pnpm local:up'."
  fi
  say ""
  say "Volumes:"
  local name
  for name in "${VOLUMES[@]}"; do
    if docker volume inspect "$name" >/dev/null 2>&1; then
      say "  $name  present (created $(docker volume inspect -f '{{.CreatedAt}}' "$name"))"
    else
      say "  $name  missing"
    fi
  done
  say ""
  say "URL: $(url)"
}

cmd_logs() {
  require_docker
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE; run 'pnpm local:up' first"
  compose logs -f --tail=200 "$@"
}

# Create or promote an administrator with the API's own bootstrap command:
# idempotent, never prints the password, and the account must enroll MFA on
# first sign-in. The password is read without echo and passed by name, so it
# appears in no process list or shell history.
cmd_admin() {
  require_docker
  refuse_production
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE; run 'pnpm local:up' first"
  [[ -t 0 ]] || die "local:admin asks for a password and needs a terminal"
  local email="${1:-}" password confirm
  if [[ -z "$email" ]]; then read -r -p "Administrator email: " email; fi
  read -r -s -p "Password: " password; printf '\n'
  read -r -s -p "Password again: " confirm; printf '\n'
  [[ "$password" == "$confirm" ]] || die "the passwords do not match"
  PALCERT_BOOTSTRAP_ADMIN_EMAIL="$email" PALCERT_BOOTSTRAP_ADMIN_PASSWORD="$password" \
    compose run --rm --no-deps \
    -e PALCERT_BOOTSTRAP_ADMIN_EMAIL -e PALCERT_BOOTSTRAP_ADMIN_PASSWORD \
    api node dist/cli/bootstrap-admin.js
}

cmd_reset() {
  require_docker
  refuse_production
  [[ -t 0 ]] || die "local:reset deletes data and must be confirmed at a terminal"
  say "This permanently deletes the local PalCert data:"
  local name
  for name in "${VOLUMES[@]}"; do say "  $name"; done
  say "Other Docker projects and volumes are not touched. The secrets file is kept."
  local answer
  read -r -p "Type '$RESET_PHRASE' to continue: " answer
  [[ "$answer" == "$RESET_PHRASE" ]] || die "not confirmed; nothing was deleted"
  if [[ -f "$ENV_FILE" ]]; then compose down --remove-orphans; fi
  for name in "${VOLUMES[@]}"; do
    if docker volume inspect "$name" >/dev/null 2>&1; then
      docker volume rm "$name" >/dev/null
      say "Deleted $name."
    fi
  done
  say "Done. 'pnpm local:up' starts a fresh, empty environment."
}

main() {
  local command="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "$command" in
    up) cmd_up "$@" ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    logs) cmd_logs "$@" ;;
    admin) cmd_admin "$@" ;;
    reset) cmd_reset ;;
    *) die "usage: palcert-local.sh {up [--no-build]|stop|status|logs [service]|admin [email]|reset}" ;;
  esac
}

main "$@"
