import request from 'supertest';
import { API } from './support/auth-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Who may speak for a client, and who may speak to the API from a browser
 * (Phase 20 Checkpoint 7).
 *
 * `X-Forwarded-For` is a request header: it is written by whoever sent the
 * request. PalCert makes two security decisions from the address it yields —
 * the per-IP login throttle and the per-IP public-verification guard — and
 * stores it on every audit record. So "who is allowed to assert it" is a
 * security boundary, and until this checkpoint the answer was `trust proxy: 1`
 * — one hop, from anybody, including anything that could open a socket to the
 * API port directly.
 *
 * The two suites below are the same requests against two deployments that
 * differ only in that setting, which is the only way to show the setting is
 * what decides.
 */

/** A code that is well-formed and resolves to nothing, so every call is a miss. */
const MISS = 'PC0000000000000000000000000000000A';

/** `PUBLIC_CERTIFICATE_VERIFY_LIMIT`, the per-IP budget on the public path. */
const VERIFY_LIMIT = 60;

async function verifyFrom(context: TestContext, forwardedFor: string | undefined): Promise<number> {
  const call = request(context.app.getHttpServer()).get(`${API}/public/certificates/${MISS}`);
  if (forwardedFor !== undefined) call.set('X-Forwarded-For', forwardedFor);
  const response = await call;
  return response.status;
}

/** Spend a client's whole budget, returning how many were admitted. */
async function exhaust(
  context: TestContext,
  forwardedFor: string | undefined,
  attempts: number,
): Promise<{ admitted: number; refused: number }> {
  let admitted = 0;
  let refused = 0;
  for (let index = 0; index < attempts; index += 1) {
    const status = await verifyFrom(context, forwardedFor);
    if (status === 429) refused += 1;
    else admitted += 1;
  }
  return { admitted, refused };
}

describe('Forwarded headers and CORS (e2e)', () => {
  describe('with no trusted proxy configured', () => {
    let context: TestContext;

    beforeAll(async () => {
      context = await createTestContext({ API_TRUSTED_PROXIES: '' });
      await resetState(context);
    });

    afterAll(async () => {
      await destroyTestContext(context);
    });

    it('ignores a forged X-Forwarded-For entirely', async () => {
      // Every request claims a different client. If the header were believed,
      // each would get its own 60-request budget and none would ever be
      // refused. Because it is not, they all share the socket address and the
      // budget runs out.
      const attempts = VERIFY_LIMIT + 10;
      let refused = 0;
      for (let index = 0; index < attempts; index += 1) {
        const status = await verifyFrom(context, `198.18.${index % 256}.${(index * 7) % 256}`);
        if (status === 429) refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
    });

    it('reports the socket address, not the claimed one, on audit records', async () => {
      // The throttle proves the decision; this proves the record. An audit
      // trail that stores whatever the client said is worse than one that
      // stores nothing, because it looks authoritative.
      await request(context.app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', '203.0.113.99')
        .send({ email: 'nobody-here@example.com', password: 'wrong-password-for-audit' });

      const events = await context.adminDb.securityEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      const addresses = events.map((event) => event.ipAddress).filter((value) => value !== null);
      expect(addresses.length).toBeGreaterThan(0);
      expect(addresses).not.toContain('203.0.113.99');
    });
  });

  describe('with loopback trusted, as a deployment behind a proxy on this host', () => {
    let context: TestContext;

    beforeAll(async () => {
      context = await createTestContext({ API_TRUSTED_PROXIES: 'loopback' });
      await resetState(context);
    });

    afterAll(async () => {
      await destroyTestContext(context);
    });

    it('believes the address the trusted upstream forwards', async () => {
      // The control for the suite above. Without it, "no client was ever
      // distinguished" would be satisfied by a broken route just as well as by
      // a correct trust model.
      const first = await exhaust(context, '198.51.100.11', VERIFY_LIMIT + 5);
      expect(first.refused).toBeGreaterThan(0);

      // A different client, immediately after, still has its own budget.
      const second = await verifyFrom(context, '198.51.100.12');
      expect(second).not.toBe(429);
    });

    it('takes the address the proxy appended, not one the client prepended', async () => {
      // A client that sends its own X-Forwarded-For and is then forwarded by a
      // trusted proxy produces a list. Express counts trusted hops from the
      // right, so the attacker's value at the left is not the one used. The
      // release proxy overwrites the header outright, making this moot there;
      // it is asserted because a different proxy might only append.
      const spent = await exhaust(context, `203.0.113.7, 198.51.100.13`, VERIFY_LIMIT + 5);
      expect(spent.refused).toBeGreaterThan(0);

      // If the *left* entry had been used, this request — which claims the
      // same left entry but a fresh right one — would have been refused too.
      const fresh = await verifyFrom(context, `203.0.113.7, 198.51.100.14`);
      expect(fresh).not.toBe(429);
    });
  });

  describe('CORS', () => {
    let context: TestContext;

    beforeAll(async () => {
      context = await createTestContext();
      await resetState(context);
    });

    afterAll(async () => {
      await destroyTestContext(context);
    });

    it('allows the configured web origin, with credentials', async () => {
      const response = await request(context.app.getHttpServer())
        .get(`${API}/public/certificates/${MISS}`)
        .set('Origin', 'https://app.palcert.test');

      expect(response.headers['access-control-allow-origin']).toBe('https://app.palcert.test');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('refuses to echo an arbitrary origin', async () => {
      const response = await request(context.app.getHttpServer())
        .get(`${API}/public/certificates/${MISS}`)
        .set('Origin', 'https://attacker.example');

      // The absence of the header is the refusal: the browser then blocks the
      // response. What must never appear is the attacker's own origin, or a
      // wildcard.
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('never answers with a wildcard origin, credentialed or not', async () => {
      for (const origin of ['https://app.palcert.test', 'https://attacker.example', '*']) {
        const response = await request(context.app.getHttpServer())
          .get(`${API}/public/certificates/${MISS}`)
          .set('Origin', origin);
        expect(response.headers['access-control-allow-origin']).not.toBe('*');
      }
    });

    it('answers a preflight for the allowed origin and not for another', async () => {
      const allowed = await request(context.app.getHttpServer())
        .options(`${API}/organizations`)
        .set('Origin', 'https://app.palcert.test')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.palcert.test');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const refused = await request(context.app.getHttpServer())
        .options(`${API}/organizations`)
        .set('Origin', 'https://attacker.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a state-changing request from an untrusted origin outright', async () => {
      // CORS is a browser control: it stops a *response* being read, and the
      // request has already happened. The CSRF guard's origin allow-list is
      // what stops the request, and it is the one that matters server-side.
      const response = await request(context.app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('Origin', 'https://attacker.example')
        .send({ email: 'someone@example.com', password: 'whatever-it-does-not-matter' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_INVALID');
    });
  });
});
