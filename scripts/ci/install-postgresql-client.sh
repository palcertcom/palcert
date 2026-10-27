#!/usr/bin/env bash
# Install the PostgreSQL client tools of one major version on a CI runner.
#
# The CI database is `postgres:17-alpine`, and `pg_dump` refuses to dump a
# server newer than its own major version, so the disaster-recovery suites need
# 17.x client tools. GitHub's ubuntu-24.04 image ships PostgreSQL 16 only. This
# adds the PostgreSQL Global Development Group (PGDG) apt repository, after
# checking its signing key against the published fingerprint, and installs
# `postgresql-client-<major>`. Nothing else on the runner is changed.
#
# Already installed: does nothing. The workflow's next step still verifies the
# binaries and asserts that the client and server majors match.
#
#   scripts/ci/install-postgresql-client.sh 17

set -euo pipefail

major="${1:?usage: install-postgresql-client.sh <major-version>}"
pg_bin="/usr/lib/postgresql/${major}/bin"

if [ -x "$pg_bin/pg_dump" ] && [ -x "$pg_bin/pg_restore" ] && [ -x "$pg_bin/psql" ]; then
  echo "postgresql-client-${major} is already installed"
  exit 0
fi

# https://www.postgresql.org/download/linux/ubuntu/ publishes this key; the
# fingerprint is what makes a substituted download fail here.
key_url=https://www.postgresql.org/media/keys/ACCC4CF8.asc
key_fingerprint=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
keyring=/usr/share/keyrings/palcert-ci-pgdg.asc

if ! grep -rqs 'apt.postgresql.org' /etc/apt/sources.list /etc/apt/sources.list.d/; then
  tmp_key="$(mktemp)"
  trap 'rm -f "$tmp_key"' EXIT
  curl -fsSL --retry 3 "$key_url" -o "$tmp_key"
  actual=$(gpg --show-keys --with-colons "$tmp_key" | awk -F: '$1 == "fpr" { print $10; exit }')
  if [ "$actual" != "$key_fingerprint" ]; then
    echo "PGDG signing key fingerprint mismatch: got '$actual'" >&2
    exit 1
  fi
  sudo install -m 0644 "$tmp_key" "$keyring"
  codename="$(awk -F= '$1 == "VERSION_CODENAME" { print $2 }' /etc/os-release)"
  echo "deb [signed-by=$keyring] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" |
    sudo tee /etc/apt/sources.list.d/palcert-ci-pgdg.list >/dev/null
fi

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  "postgresql-client-${major}"

"$pg_bin/pg_dump" --version
