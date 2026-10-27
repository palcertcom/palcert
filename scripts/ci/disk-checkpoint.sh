#!/usr/bin/env bash
# Record the disk at one point of a CI job, and optionally insist on headroom.
#
#   scripts/ci/disk-checkpoint.sh <label> [--min-free-gb N]
#
# Read-only: prints the free space on /, what Docker holds (images, build
# cache, volumes) and the workspace size. With --min-free-gb it exits 1 when
# less than N GB are free, so a job that is running out of disk says where
# and by how much instead of failing later on an unrelated write. Safe on any
# machine; it changes nothing.

set -euo pipefail

label="${1:?usage: disk-checkpoint.sh <label> [--min-free-gb N]}"
shift
min_gb=0
if [ "${1:-}" = "--min-free-gb" ]; then
  min_gb="${2:?--min-free-gb needs a number}"
fi

free_gb="$(df -Pk / | awk 'NR == 2 { print int($4 / 1048576) }')"
used_gb="$(df -Pk / | awk 'NR == 2 { print int($3 / 1048576) }')"
echo "disk-checkpoint $label: / has $free_gb GB free, $used_gb GB used (minimum here: $min_gb GB)"
if timeout 20 docker info > /dev/null 2>&1; then
  timeout 30 docker system df --format '  docker {{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' || true
fi
if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  echo "  workspace: $(du -sh "$GITHUB_WORKSPACE" 2>/dev/null | cut -f1)"
fi

if [ "$free_gb" -lt "$min_gb" ]; then
  echo "disk-checkpoint $label: only $free_gb GB free, at least $min_gb GB are needed from here" >&2
  exit 1
fi
