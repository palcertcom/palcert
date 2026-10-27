#!/bin/sh
# Installed root-owned. authorized_keys forces this command for this key.
set -eu
test "${SSH_ORIGINAL_COMMAND-}" = palcert-deploy || exit 64
exec /usr/bin/sudo -n /usr/local/lib/palcert-deploy/receive.py
