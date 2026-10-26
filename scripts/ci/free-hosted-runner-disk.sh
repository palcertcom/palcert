#!/usr/bin/env bash
# Make room on a GitHub-hosted runner before the disk-heavy CI jobs, then
# prove the job has the headroom it needs.
#
# A standard GitHub-hosted Linux runner for a public repository guarantees
# 14 GB of SSD. The image job builds five production images plus the CI
# object store, then runs the release stack next to node_modules, the pnpm
# store and a browser. On an equivalent 4-vCPU/16 GB machine the six builds
# alone took 10.1 GiB from a clean cache; with the copies buildx loads into
# Docker, the stack's own images (ClamAV and its signatures, PostgreSQL, k6,
# ...), node_modules and Chromium the job needs roughly 17 GB, more than the
# guarantee. The runner image carries large toolchains PalCert never uses;
# removing them leaves every check, image and test exactly as it was.
#
# Deletes system directories, so it runs on GitHub's ephemeral hosted VM and
# nowhere else. It REFUSES (exit 78, nothing removed) unless every one of
# these holds: GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted, ImageOS
# names a GitHub Ubuntu image, the user is the hosted image's `runner`, and
# the kernel is not WSL. A self-hosted runner, a developer machine, WSL or a
# server fails the first check it does not meet.
#
# --require-free-gb N then fails the job (exit 1) unless at least N GB are
# free on / after the cleanup, so a runner image that shrinks is caught
# before an hour of work rather than by a full disk in the middle of it.
#
#   scripts/ci/free-hosted-runner-disk.sh --require-free-gb 25

set -euo pipefail

require_gb=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --require-free-gb)
      require_gb="${2:?--require-free-gb needs a number}"
      shift 2
      ;;
    *)
      echo "usage: free-hosted-runner-disk.sh [--require-free-gb N]" >&2
      exit 64
      ;;
  esac
done

refuse() {
  echo "free-hosted-runner-disk: REFUSED, nothing removed: $1" >&2
  exit 78
}
[ "${GITHUB_ACTIONS:-}" = "true" ] || refuse "not inside GitHub Actions"
[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] ||
  refuse "RUNNER_ENVIRONMENT is '${RUNNER_ENVIRONMENT:-}', not github-hosted"
case "${ImageOS:-}" in
  ubuntu[0-9][0-9]) ;;
  *) refuse "ImageOS is '${ImageOS:-}', not a GitHub-hosted Ubuntu image" ;;
esac
[ "$(id -un)" = "runner" ] || refuse "the user is '$(id -un)', not the hosted image's 'runner'"
if grep -qi microsoft /proc/version 2>/dev/null; then
  refuse "this is a WSL kernel"
fi

free_gb() { df -Pk / | awk 'NR == 2 { print int($4 / 1048576) }'; }
echo "free-hosted-runner-disk: $ImageOS ${ImageVersion:-}; free before: $(free_gb) GB"

# .NET, Android, Haskell, Swift and CodeQL: none is used by any PalCert job.
# Node, Python, Docker, Chrome and the tool cache entries that the setup
# actions use are deliberately not touched.
for path in \
  /usr/share/dotnet \
  /usr/local/lib/android \
  /opt/ghc \
  /usr/local/.ghcup \
  /usr/share/swift \
  /opt/hostedtoolcache/CodeQL; do
  if [ -e "$path" ]; then
    sudo rm -rf "$path"
    echo "free-hosted-runner-disk: removed $path"
  fi
done

after="$(free_gb)"
echo "free-hosted-runner-disk: free after: $after GB (required: $require_gb GB)"
if [ "$after" -lt "$require_gb" ]; then
  echo "free-hosted-runner-disk: only $after GB free, the job needs $require_gb GB" >&2
  exit 1
fi
