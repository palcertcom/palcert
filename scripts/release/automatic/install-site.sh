#!/usr/bin/env bash
# Operator-run from a hash-verified source archive. NEVER invoked from SSH input.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$EUID" = 0 ]] || exit 77
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
target=/usr/local/lib/palcert-deploy
test -f "$target/receive.py"
test ! -e "$target/site_adapter.py"
test ! -e /etc/palcert/deployment-site
python3 -I -c 'import json; assert json.load(open("/etc/palcert/deploy.json"))["enabled"] is False'
# These files are new; existing SSH/sudo policy, keys and receiver stay intact.
for file in site_config.py site_adapter.py prepare-site.py queue-control.cjs; do
  install -o root -g root -m 644 "$here/$file" "$target/$file"
done
policy="$target/site-source"
install -d -o root -g root -m 700 "$policy/docker" "$policy/scripts/release" "$policy/packages/database/prisma/migrations"
install -o root -g root -m 644 "$repo/docker/release-postgres-init.sh" "$policy/docker/"
install -o root -g root -m 600 "$repo/scripts/release/rehearse-database-upgrade.sh" "$policy/scripts/release/"
for migration in "$repo"/packages/database/prisma/migrations/[0-9]*; do
  name="$(basename "$migration")"
  install -d -o root -g root -m 700 "$policy/packages/database/prisma/migrations/$name"
  install -o root -g root -m 600 "$migration/migration.sql" "$policy/packages/database/prisma/migrations/$name/"
done
install -d -o root -g root -m 700 /var/backups/palcert
for phase in preflight pull drain backup rehearse apply verify resume; do
  test ! -e "$target/hooks/$phase"
  printf '#!/bin/sh\nexec /usr/bin/python3 -I /usr/local/lib/palcert-deploy/site_adapter.py %s "$@"\n' "$phase" > "$target/hooks/$phase"
  chown root:root "$target/hooks/$phase"
  chmod 755 "$target/hooks/$phase"
done
python3 -I "$target/prepare-site.py"
echo 'Hooks installed but NOT activated. Complete the isolated integration rehearsal first.'
