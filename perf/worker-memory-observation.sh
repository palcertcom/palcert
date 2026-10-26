#!/usr/bin/env bash
# P-014: is the worker's memory drift real? (Phase 20 Checkpoint 7)
#
#   PROJECT=palcert-c7 DURATION=1800 bash perf/worker-memory-observation.sh
#
# Checkpoint 20.6's twenty-minute soak sampled the worker every thirty seconds
# while public verification ran at 120 rps. The API and the document engine
# were flat; the worker rose about 11 MiB/hour — while not itself under load,
# because the workload was verification and the worker had nothing to do.
#
# That number was recorded as an assumption rather than a conclusion, because
# twenty minutes cannot tell settling allocation from a slow leak. This is the
# controlled re-run: the same process, idle or nearly so, sampled for longer,
# with nothing else changing.
#
# It answers exactly one question and reports one of three words:
#
#   flat           — no growth beyond sampling noise.
#   reproducible   — growth of the same shape and order as 20.6 measured.
#   inconclusive   — the run could not distinguish the two.
#
# It does not optimize anything. A memory graph is not a bug report.
set -uo pipefail

PROJECT="${PROJECT:-palcert-c7}"
DURATION="${DURATION:-1800}"
INTERVAL="${INTERVAL:-30}"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
SAMPLES="$OUT/worker-memory.tsv"

container="${PROJECT}-worker-1"
if ! docker inspect "$container" > /dev/null 2>&1; then
  echo "worker-memory: $container is not running" >&2
  exit 78
fi

printf 't\tworker_mib\tapi_mib\tjobs_total\n' > "$SAMPLES"

# The queue depth travels with the memory figure. "Memory rose" means
# something different if the worker was processing jobs than if it was idle,
# and 20.6's observation was specifically about an *idle* worker.
jobs_in_queue() {
  docker exec "${PROJECT}-postgres-1" psql -U palcert_app -d palcert -tAqc \
    "SELECT count(*) FROM processing_jobs WHERE status IN ('PENDING','RUNNING');" 2>/dev/null \
    | tr -d ' ' || echo ''
}

mib() { # container
  docker stats --no-stream --format '{{.MemUsage}}' "$1" 2>/dev/null \
    | awk '{print $1}' | sed 's/MiB//;s/GiB/*1024/' | bc -l 2>/dev/null
}

elapsed=0
while [ "$elapsed" -lt "$DURATION" ]; do
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
  printf '%s\t%s\t%s\t%s\n' "$elapsed" "$(mib "$container")" \
    "$(mib "${PROJECT}-api-1")" "$(jobs_in_queue)" >> "$SAMPLES"
done

echo "worker-memory: $(( $(wc -l < "$SAMPLES") - 1 )) samples over ${DURATION}s in $SAMPLES"

# The verdict, computed rather than eyeballed. The slope is taken over the
# second half only, because the first minutes are start-up allocation and
# including them reports warm-up as a leak — the same mistake 20.6 avoided.
python3 - "$SAMPLES" "$DURATION" <<'PY'
import sys

path, duration = sys.argv[1], int(sys.argv[2])
rows = [line.split('\t') for line in open(path).read().strip().split('\n')[1:]]
points = []
for row in rows:
    try:
        points.append((int(row[0]), float(row[1])))
    except (ValueError, IndexError):
        continue

half = [p for p in points if p[0] >= duration / 2]
if len(half) < 5:
    print('worker-memory: VERDICT inconclusive — too few usable samples')
    raise SystemExit(0)

n = len(half)
mx = sum(p[0] for p in half) / n
my = sum(p[1] for p in half) / n
denominator = sum((p[0] - mx) ** 2 for p in half)
slope_per_hour = (sum((p[0] - mx) * (p[1] - my) for p in half) / denominator) * 3600

spread = max(p[1] for p in half) - min(p[1] for p in half)
first, last = points[0][1], points[-1][1]
print(f'worker-memory: first={first:.1f} MiB last={last:.1f} MiB')
print(f'worker-memory: second-half slope {slope_per_hour:+.2f} MiB/h over {n} samples, spread {spread:.2f} MiB')

# 20.6 measured +11.3 MiB/h. "Reproducible" means the same sign and the same
# order of magnitude; "flat" means a slope small enough that it would take
# months to matter and is within the noise the spread shows.
if abs(slope_per_hour) < 2 and spread < 5:
    print('worker-memory: VERDICT flat')
elif slope_per_hour > 4:
    print('worker-memory: VERDICT reproducible')
else:
    print('worker-memory: VERDICT inconclusive')
PY
