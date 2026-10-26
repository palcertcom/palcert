// The CI performance smoke (Phase 20 Checkpoint 6).
//
//   k6 run -e PALCERT_VALID_CODE=… perf/k6/smoke.js
//
// Deliberately small. It runs on every release build and exists to catch a
// gross regression — an endpoint that became ten times slower, or one that
// started returning the wrong thing — not to measure capacity. The heavy
// capacity, saturation and soak runs stay manual or release-gated, because a
// thirty-minute benchmark in CI is a benchmark people learn to skip.
//
// It asserts thresholds, unlike the capacity scenarios: here a threshold is
// the point. The values are deliberately loose, chosen well above the
// measured p95 on the smallest environment this is expected to run on, so
// that ordinary variance between runners does not turn it into noise. A smoke
// test that fails half the time is a smoke test that gets deleted.
import { check } from 'k6';
import http from 'k6/http';
import { API, VALID_CODE, missCode } from './lib/env.js';

/**
 * Two scenarios, at very different rates, because the endpoints have very
 * different guards.
 *
 * Public verification carries a per-IP limit of 60 requests per
 * fifteen-minute window — a brute-force guard on a capability. A CI smoke
 * runs from one address, so it gets 60 verification requests and no more.
 * The first version of this file ran everything at 10 rps for 20 seconds,
 * spent the budget in the first six seconds, and reported a 49% check
 * failure rate that was entirely its own doing.
 *
 * So verification is probed a handful of times, and the cheap unguarded
 * liveness path carries the throughput end of the smoke.
 */
export const options = {
  scenarios: {
    health: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.PALCERT_RATE || 10),
      timeUnit: '1s',
      duration: __ENV.PALCERT_DURATION || '20s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'healthProbe',
    },
    verification: {
      executor: 'constant-arrival-rate',
      // Comfortably inside the guard: 1/s for 20 s is 20 of the 60 available.
      rate: 1,
      timeUnit: '1s',
      duration: __ENV.PALCERT_DURATION || '20s',
      preAllocatedVUs: 2,
      maxVUs: 5,
      exec: 'verificationProbe',
    },
  },
  insecureSkipTLSVerify: true,
  thresholds: {
    // Measured p95 for public verification on a four-CPU host with the whole
    // stack and the generator co-resident was ~6 ms at 100 rps. 250 ms is
    // roughly forty times that: it will not catch a 20% slowdown, and it will
    // catch an endpoint that started doing something quadratic.
    'http_req_duration{expected_response:true}': ['p(95)<250'],
    // Correctness, which is the part most worth protecting. Any failure here
    // means the endpoint stopped behaving, not that it got slower.
    checks: ['rate==1.0'],
    // The liveness probe has no database or network behind it, so a
    // regression here is the process itself.
    'http_req_duration{name:health}': ['p(95)<100'],
  },
};

export function healthProbe() {
  const health = http.get(`${__ENV.PALCERT_BASE_URL || 'https://127.0.0.1:8443'}/health/live`, {
    tags: { name: 'health' },
  });
  check(health, { 'health is 200': (r) => r.status === 200 });
}

export function verificationProbe() {
  // A miss, always: it needs no fixture, so the smoke runs anywhere the API
  // runs. The hit is checked too, but only when a code was supplied.
  const miss = http.get(`${API}/public/certificates/${missCode(__ITER)}`, {
    tags: { name: 'verify-miss' },
  });
  check(miss, {
    'miss is 404': (r) => r.status === 404,
    // Names the certificate, not the route: a mistyped path also answers 404,
    // and Checkpoint 20.5 shipped a check that passed for exactly that reason.
    'miss is CERTIFICATE_NOT_FOUND': (r) => r.body.includes('CERTIFICATE_NOT_FOUND'),
  });

  if (VALID_CODE !== '') {
    const hit = http.get(`${API}/public/certificates/${VALID_CODE}`, {
      tags: { name: 'verify-hit' },
    });
    check(hit, {
      'hit is 200': (r) => r.status === 200,
      'hit returns a certificate': (r) => r.body.includes('verificationStatus'),
    });
  }
}
