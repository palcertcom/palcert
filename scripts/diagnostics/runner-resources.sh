#!/usr/bin/env bash
# What was this runner doing while the job was slow?
#
# A read-only snapshot of the self-hosted runner's CPU, memory, I/O pressure,
# disk, containers and heaviest processes, printed into the job log. The same
# commit has run with typecheck in 2.5 minutes and in 16.5, and with a fresh
# PostgreSQL initialised in seconds and in 2.5 minutes; without a snapshot from
# the run itself, "the host was busy" is a guess. With one it is evidence, and
# it says with what.
#
# Changes nothing: no cleanup, no container or image is stopped or removed.
# Prints process names, never command lines, so no argument can leak a secret.
# Always exits 0; diagnostics must not be the reason a job fails.
#
#   scripts/diagnostics/runner-resources.sh <label>

set -u
label="${1:-snapshot}"
probe_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

section() { printf '\n── %s ──\n' "$1"; }

printf '=== runner resources: %s at %s ===\n' "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

section 'host'
uname -sr 2>/dev/null
grep -qi microsoft /proc/version 2>/dev/null && echo 'kernel: WSL'
echo "cpus: $(nproc 2>/dev/null)"
echo "load average: $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "uptime: $(uptime -p 2>/dev/null)"

section 'memory'
free -m 2>/dev/null

# Pressure stall information: the share of time tasks were stalled waiting
# for CPU, memory or I/O. "some avg60=40" means something was stalled 40% of
# the last minute -- the direct measure of contention, unlike load average.
section 'pressure (PSI)'
for resource in cpu memory io; do
  if [ -r "/proc/pressure/$resource" ]; then
    sed "s/^/$resource /" "/proc/pressure/$resource"
  else
    echo "$resource: not available on this kernel"
  fi
done

# si/so is swap traffic, wa is time waiting on I/O, r is the run queue.
section 'vmstat (3 x 1s)'
timeout 10 vmstat 1 3 2>/dev/null || echo 'vmstat unavailable'

section 'disk'
df -h "${GITHUB_WORKSPACE:-$PWD}" "$probe_dir" 2>/dev/null | awk '!seen[$0]++'
docker_root="$(timeout 10 docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
[ -n "$docker_root" ] && df -h "$docker_root" 2>/dev/null | tail -n +2 | sed 's/^/docker-root /'

# Synchronous 8 KiB writes, the shape of a database commit. Healthy local disks
# do thousands per second; a starved or thrashing host does tens.
section 'fsync probe (256 x 8 KiB, O_DSYNC)'
probe="$probe_dir/.palcert-fsync-probe-$$"
timeout 60 dd if=/dev/zero of="$probe" bs=8k count=256 oflag=dsync 2>&1 | tail -n 1
rm -f "$probe"

section 'docker'
if timeout 10 docker info >/dev/null 2>&1; then
  timeout 10 docker info --format 'server {{.ServerVersion}}, storage {{.Driver}}, cpus {{.NCPU}}, memory {{.MemTotal}} bytes, containers running {{.ContainersRunning}}' 2>/dev/null
  echo
  timeout 20 docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null
  echo
  timeout 30 docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}' 2>/dev/null
  echo
  timeout 30 docker system df 2>/dev/null
else
  echo 'docker daemon not reachable'
fi

section 'top processes by CPU'
ps -eo pid,ppid,etime,%cpu,%mem,rss,comm --sort=-%cpu 2>/dev/null | head -n 13

section 'top processes by memory'
ps -eo pid,ppid,etime,%cpu,%mem,rss,comm --sort=-rss 2>/dev/null | head -n 13

# A Jest worker or Node process that outlived an earlier job keeps its CPU,
# memory and database connections. List them by name and age only.
section 'node / jest processes'
pids="$(pgrep -f 'jest|ts-jest|node' 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
if [ -n "$pids" ]; then
  ps -o pid,ppid,etime,%cpu,rss,comm -p "$pids" 2>/dev/null
else
  echo 'none'
fi

printf '\n=== end of runner resources: %s ===\n' "$label"
exit 0
