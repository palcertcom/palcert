#!/usr/bin/env bash
# Operator-run once, after reviewing the files at a pinned source commit.
# Installs NO rollout hooks and leaves deployment disabled. Never starts services.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$EUID" = 0 ]] || { echo 'Run this installer through sudo.' >&2; exit 77; }
public_key_file="${1:?path to the NEW deployment PUBLIC key is required}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
read -r key_type key_data _ < "$public_key_file"
[[ "$key_type" = ssh-ed25519 && "$key_data" =~ ^[A-Za-z0-9+/=]+$ ]] || exit 64
[[ "$(wc -l < "$public_key_file")" = 1 ]] || exit 64
ssh-keygen -lf "$public_key_file" >/dev/null
# Refuse to replace an existing account, key, sudo policy or controller install.
if id palcert-deploy >/dev/null 2>&1 || [[ -e /usr/local/lib/palcert-deploy || -e /etc/palcert/deploy.json || -e /etc/sudoers.d/palcert-deploy || -e /var/lib/palcert-deploy || -e /var/lib/palcert-deploy-user ]]; then
  echo 'Deployment installation already exists; inspect it instead of overwriting it.' >&2
  exit 73
fi
command -v visudo >/dev/null
test -x /usr/bin/python3
test -d /etc/palcert
useradd --system --user-group --home-dir /var/lib/palcert-deploy-user --shell /bin/sh palcert-deploy
install -d -o root -g root -m 755 /var/lib/palcert-deploy-user
install -d -o root -g palcert-deploy -m 750 /var/lib/palcert-deploy-user/.ssh
install -d -o root -g root -m 755 /usr/local/lib/palcert-deploy /usr/local/lib/palcert-deploy/hooks
install -d -o root -g root -m 700 /var/lib/palcert-deploy
install -o root -g root -m 755 "$here/receive.py" /usr/local/lib/palcert-deploy/receive.py
install -o root -g root -m 755 "$here/ssh-command.sh" /usr/local/lib/palcert-deploy/ssh-command.sh
install -o root -g root -m 600 "$here/server-config.example.json" /etc/palcert/deploy.json
printf 'restrict,command="/usr/local/lib/palcert-deploy/ssh-command.sh" %s %s palcert-actions\n' \
  "$key_type" "$key_data" > /var/lib/palcert-deploy-user/.ssh/authorized_keys
chown root:palcert-deploy /var/lib/palcert-deploy-user/.ssh/authorized_keys
chmod 640 /var/lib/palcert-deploy-user/.ssh/authorized_keys
sudo_policy=$(mktemp)
trap 'rm -f "$sudo_policy"' EXIT
printf '%s\n' 'palcert-deploy ALL=(root) NOPASSWD: /usr/local/lib/palcert-deploy/receive.py ""' > "$sudo_policy"
visudo -cf "$sudo_policy" >/dev/null
install -o root -g root -m 440 "$sudo_policy" /etc/sudoers.d/palcert-deploy
echo 'Restricted receiver installed DISABLED. Production services and existing settings were not changed.'
echo 'Do not enable it until all site hooks and the end-to-end rehearsal are reviewed.'
