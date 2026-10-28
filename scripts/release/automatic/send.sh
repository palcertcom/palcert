#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PALCERT_DEPLOY_HOST:?set the production environment host variable}"
: "${PALCERT_DEPLOY_USER:?set the production environment user variable}"
: "${PALCERT_DEPLOY_KEY:?install the dedicated deployment key in environment secrets}"
: "${PALCERT_DEPLOY_KNOWN_HOSTS:?install the independently verified SSH host key}"
port="${PALCERT_DEPLOY_PORT:-22}"
[[ "$PALCERT_DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || exit 64
[[ "$PALCERT_DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 64
[[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port > 0 && 10#$port <= 65535 )) || exit 64
private=$(mktemp -d)
trap 'rm -rf "$private"' EXIT
printf '%s\n' "$PALCERT_DEPLOY_KEY" > "$private/key"
printf '%s\n' "$PALCERT_DEPLOY_KNOWN_HOSTS" > "$private/known_hosts"
unset PALCERT_DEPLOY_KEY PALCERT_DEPLOY_KNOWN_HOSTS
ssh -T -p "$port" -i "$private/key" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$private/known_hosts" -o GlobalKnownHostsFile=/dev/null \
  -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
  -o ForwardAgent=no -o ClearAllForwardings=yes \
  "$PALCERT_DEPLOY_USER@$PALCERT_DEPLOY_HOST" palcert-deploy \
  < deployment-request.json > deployment-receipt.json
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const receipt = JSON.parse(readFileSync('deployment-receipt.json', 'utf8'));
const request = JSON.parse(readFileSync('deployment-request.json', 'utf8'));
if (receipt.outcome !== 'success' || receipt.commit !== request.commit ||
    receipt.manifestDigest !== request.freeze.manifest.digest) {
  throw new Error('The server did not confirm this exact deployment');
}
console.log(`Production verified ${receipt.commit}`);
JS
