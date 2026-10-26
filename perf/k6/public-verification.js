// W1 — public certificate verification (Phase 20 Checkpoint 6).
//
//   k6 run -e PALCERT_VALID_CODE=… perf/k6/public-verification.js
//
// The only surface the open internet reaches, and the one most likely to be
// scraped. Measured on its own before any mixed workload, because a number
// taken while uploads and analyses are competing for the same four CPUs says
// nothing about this endpoint.
//
// Hits and misses are counted separately and reported separately. The
// question this scenario exists to answer is not "how fast is verification"
// but "does an unknown code cost more than a known one" — because if it did,
// the cheapest way to hurt PalCert would be to ask it about certificates that
// do not exist. Structurally it should not: the lookup is one indexed
// equality on `verification_code_hash`, and on a miss the two joins behind it
// never execute. This measures whether that holds in practice.
import { check } from 'k6';
import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';
import { API, VALID_CODE, missCode } from './lib/env.js';

/**
 * One simulated client per VU.
 *
 * Public verification carries a dedicated per-IP guard —
 * PUBLIC_CERTIFICATE_VERIFY_LIMIT, 60 requests per window — because a
 * verification code is a capability and a script must not be able to sit and
 * guess. From a single origin that guard binds immediately, which is the
 * correct behaviour and is measured in its own run.
 *
 * To measure what the endpoint can do *behind* the guard, this presents many
 * distinct clients rather than removing it. The API trusts one proxy hop, so
 * addressing it directly with a per-VU X-Forwarded-For is exactly what a
 * crowd of real clients looks like to the limiter. Nothing is disabled and no
 * constant is raised: the guard still applies, to each simulated client.
 *
 * Off unless PALCERT_SPREAD_CLIENTS is set, so the default run measures the
 * system as a real single-origin caller experiences it.
 */
const SPREAD_CLIENTS = __ENV.PALCERT_SPREAD_CLIENTS === 'true';

/**
 * 198.18.0.0/15 — the range IANA reserves for inter-network *benchmarking*
 * (RFC 2544). Not documentation space: 131 072 addresses, which is what this
 * needs.
 *
 * The first version drew from a single /24. That is 254 clients, and the
 * verification guard's window is fifteen minutes, so the whole generator had
 * a budget of 254 × 60 = 15 240 requests per window — shared across every
 * run in that window. A sweep at 200, then 400, then 800 rps duly reported
 * rising rate-limiting and rising latency, which looked exactly like the
 * system saturating and was nothing of the sort: the generator had run out
 * of client identities. A number that is really about the load tool is worse
 * than no number, because it reads as a finding.
 *
 * Varying per iteration rather than per VU, so client count scales with
 * request count instead of with concurrency.
 */
function clientHeaders() {
  if (!SPREAD_CLIENTS) return {};
  // 198.18.0.0/15 spans 198.18.0.0-198.19.255.255, so the *second* octet
  // carries the high bit of the host part, not the third.
  const n = (__VU * 1_000_003 + __ITER) % 131_072;
  return {
    'X-Forwarded-For': `198.${18 + Math.floor(n / 65_536)}.${Math.floor(n / 256) % 256}.${n % 256}`,
  };
}

const hitLatency = new Trend('palcert_verify_hit_ms', true);
const missLatency = new Trend('palcert_verify_miss_ms', true);
const rateLimited = new Rate('palcert_rate_limited');
const unexpected = new Rate('palcert_unexpected_status');

/**
 * Arrival-rate, not fixed VUs.
 *
 * With fixed VUs the generator slows down as the system does, and the run
 * reports whatever throughput the system happened to sustain — which always
 * looks like success. A constant arrival rate offers load regardless, so the
 * gap between offered and achieved is visible, and that gap is what
 * saturation means.
 */
export const options = {
  scenarios: {
    verification: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.PALCERT_RATE || 50),
      timeUnit: '1s',
      duration: __ENV.PALCERT_DURATION || '60s',
      preAllocatedVUs: Number(__ENV.PALCERT_VUS || 50),
      maxVUs: Number(__ENV.PALCERT_MAX_VUS || 300),
    },
  },
  insecureSkipTLSVerify: true,
  // Reported, never enforced here: a capacity run that aborts on a threshold
  // cannot find the saturation point it was run to find.
  thresholds: {},
};

export default function publicVerification() {
  // Half hits, half misses (assumption A6: under scraping an invalid code is
  // at least as common as a valid one). The split is deterministic per
  // iteration so a run is reproducible.
  const wantHit = VALID_CODE !== '' && __ITER % 2 === 0;
  const code = wantHit ? VALID_CODE : missCode(__VU * 100003 + __ITER);

  const response = http.get(`${API}/public/certificates/${code}`, {
    tags: { name: 'public-verification', outcome: wantHit ? 'hit' : 'miss' },
    headers: clientHeaders(),
  });

  if (response.status === 429) {
    // Not an error, and not a failure of the run. Public verification carries
    // a dedicated per-IP guard of 60 requests per window because a
    // verification code is a capability. From one origin it binds at once —
    // that is the endpoint working, and the rate at which it binds is itself
    // one of the results.
    rateLimited.add(1);
    return;
  }
  rateLimited.add(0);

  if (wantHit) {
    hitLatency.add(response.timings.duration);
    unexpected.add(response.status !== 200);
    check(response, {
      'hit returns 200': (r) => r.status === 200,
      // The body must come from the verification handler, not merely be a 200
      // from somewhere. `verificationStatus` is the field the public
      // projection publishes — the first version of this check looked for
      // `issuanceStatus`, the *column* name, which never appears in the
      // response, so it failed every single hit while "returns 200" passed
      // beside it. A body assertion is only worth having if it names
      // something the body actually contains.
      'hit returns a certificate': (r) => r.status === 200 && r.body.includes('verificationStatus'),
    });
  } else {
    missLatency.add(response.timings.duration);
    unexpected.add(response.status !== 404);
    check(response, {
      'miss returns 404': (r) => r.status === 404,
      'miss names the certificate, not the route': (r) =>
        r.status === 404 && r.body.includes('CERTIFICATE_NOT_FOUND'),
    });
  }
}
