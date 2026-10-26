// W2 — authenticated navigation (Phase 20 Checkpoint 6).
//
//   k6 run -e PALCERT_USER=… -e PALCERT_PASSWORD=… perf/k6/authenticated.js
//
// Measured apart from public verification because it costs more in a way the
// public path never does: every tenant-scoped query runs under row-level
// security, which is FORCEd on 64 tables with 104 policies, and every request
// carries a session lookup. The difference between this and W1 is the price
// of tenancy, and it is worth knowing separately.
//
// Identities are bounded and synthetic — the users the Checkpoint 20.4
// recovery fixture created. Each VU signs in once and reuses its session, as
// a browser does; a scenario that logged in on every iteration would measure
// Argon2 rather than navigation.
import { check, fail } from 'k6';
import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';
import { API } from './lib/env.js';

const navigation = new Trend('palcert_authenticated_ms', true);
const rateLimited = new Rate('palcert_rate_limited');
const unauthorized = new Rate('palcert_unauthorized');

const USER = __ENV.PALCERT_USER || '';
const PASSWORD = __ENV.PALCERT_PASSWORD || '';

/**
 * A ramp in one run, rather than a run per rate.
 *
 * Sign-in is throttled per IP over a fifteen-minute window, so a sweep made
 * of separate runs spends a login on each and eventually cannot sign in at
 * all — which is what happened here: four consecutive runs, then 429, and the
 * three runs in between had reported throughput figures that were really just
 * their own failed setup. One run, one sign-in, several stages.
 */
const STAGES = (__ENV.PALCERT_STAGES || '50:20s,100:20s,200:20s,400:20s')
  .split(',')
  .map((stage) => {
    const [target, duration] = stage.split(':');
    return { target: Number(target), duration };
  });

export const options = {
  scenarios: {
    navigation: {
      executor: 'ramping-arrival-rate',
      startRate: STAGES[0].target,
      timeUnit: '1s',
      stages: STAGES,
      preAllocatedVUs: Number(__ENV.PALCERT_VUS || 100),
      maxVUs: Number(__ENV.PALCERT_MAX_VUS || 800),
    },
  },
  insecureSkipTLSVerify: true,
  thresholds: {},
};

/**
 * One sign-in per VU, on that VU's first iteration.
 *
 * k6 gives every VU its own cookie jar and fills it automatically from
 * Set-Cookie, so signing in once per VU leaves the session in place for that
 * VU's remaining iterations — which is what a browser does, and it keeps the
 * number of sessions bounded so the run does not measure session-table
 * growth either.
 *
 * The first version signed in inside `setup()` and tried to copy the cookies
 * into each VU's jar by hand. It did not work: every request came back 401,
 * and because a rejection is fast the run reported a very flattering 2 ms
 * p50 for what it called "navigation". The `unauthorized` rate is checked
 * and reported for exactly that reason — an authenticated scenario that has
 * quietly stopped being authenticated looks like excellent performance.
 */
let sessionHeader = null;

function signIn() {
  const response = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: USER, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'sign-in' } },
  );
  if (response.status !== 200) {
    fail(`sign-in failed with ${response.status}; the fixture user may not exist here`);
  }

  // The session is carried explicitly rather than left to k6's per-VU cookie
  // jar. Relying on the jar gave exactly one authorized request per VU and
  // 401 for every one after it — with curl the same session works
  // indefinitely, so the API is fine and the jar was not carrying the cookie
  // across iterations. Sending it as a header removes the question.
  const parts = [];
  for (const name of ['palcert_session', 'palcert_csrf']) {
    const values = response.cookies[name];
    if (values && values.length > 0) parts.push(`${name}=${values[0].value}`);
  }
  if (parts.length === 0) fail('sign-in returned no session cookie');
  sessionHeader = parts.join('; ');
}

/**
 * One sign-in for the whole run, not one per VU.
 *
 * Sign-in is throttled per IP, deliberately — it is the brute-force guard on
 * credentials. A hundred VUs each signing in from one address trips it, the
 * VUs abort, and the run reports nothing at all, which is what happened at
 * 100 rps and above. Signing in once in `setup` and sharing the session is
 * also closer to what is being measured: navigation under a valid session,
 * not the cost of authenticating.
 */
export function setup() {
  if (USER === '' || PASSWORD === '') {
    fail('PALCERT_USER and PALCERT_PASSWORD are required');
  }
  signIn();
  return { session: sessionHeader };
}

export default function authenticatedNavigation(data) {
  if (sessionHeader === null) sessionHeader = data.session;

  // The first screen an authenticated user lands on: who am I, and what
  // organizations can I see. Both are tenant-scoped, so both pay for RLS.
  const response = http.get(`${API}/organizations`, {
    tags: { name: 'authenticated-navigation' },
    headers: { Cookie: sessionHeader },
  });

  if (response.status === 429) {
    rateLimited.add(1);
    return;
  }
  rateLimited.add(0);
  unauthorized.add(response.status === 401 || response.status === 403);
  navigation.add(response.timings.duration);

  check(response, {
    'navigation returns 200': (r) => r.status === 200,
    // A session that has silently stopped working would otherwise show up as
    // excellent latency on a 401. It did, on the first run of this scenario.
    'navigation is authorized': (r) => r.status !== 401 && r.status !== 403,
  });
}
