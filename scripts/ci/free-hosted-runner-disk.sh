#!/usr/bin/env bash
# Make room on a GitHub-hosted runner before the disk-heavy CI jobs.
#
# A standard GitHub-hosted Linux runner for a public repository guarantees
# 14 GB of SSD. The image job builds five production images plus the CI
# object store, then runs the release stack next to node_modules, the pnpm
# store and a browser. On an equivalent 4-vCPU/16 GB machine the six builds
# alone took 10.1 GiB from a clean cache; with the stack's own images (ClamAV
# and its signatures, PostgreSQL, k6, ...), node_modules and Chromium the job
# needs roughly 15-16 GB, more than the guarantee. The runner image carries
# large toolchains PalCert never uses; removing them leaves every check, image
# and test exactly as it was.
#
# Only on GitHub-hosted runners (RUNNER_ENVIRONMENT=github-hosted). Anywhere
# else it changes nothing: these paths may be in real use on a machine that
# is not a throwaway VM. Prints the free space before and after.
#
#   scripts/ci/free-hosted-runner-disk.sh

set -euo pipefail

if [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
  echo "free-hosted-runner-disk: not a GitHub-hosted runner (RUNNER_ENVIRONMENT='${RUNNER_ENVIRONMENT:-}'); nothing removed"
  exit 0
fi

df -h / | tail -n 1 | awk '{ print "free before: " $4 " of " $2 }'

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
    echo "removed $path"
  fi
done

df -h / | tail -n 1 | awk '{ print "free after:  " $4 " of " $2 }'
