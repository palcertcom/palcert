import { REQUEST_ID_HEADER } from '@palcert/contracts';
import request from 'supertest';
import { createTestContext, destroyTestContext, type TestContext } from './support/test-app';

/**
 * Health and cross-cutting HTTP behaviour.
 *
 * Boots through the same hermetic test context as every other suite (§95.1):
 * the environment is constructed explicitly, so this file behaves identically
 * on a developer machine, in CI and in a remote session, and never depends
 * on whatever the shell happens to export.
 */
describe('Health endpoints (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  const server = () => context.app.getHttpServer();

  it('GET /health/live returns 200 without touching dependencies', async () => {
    const response = await request(server()).get('/health/live').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', service: expect.any(String) });
    expect(response.body.dependencies).toEqual([]);
  });

  it('GET /health/ready reports database, redis and object storage', async () => {
    const response = await request(server()).get('/health/ready');

    expect([200, 503]).toContain(response.status);
    const names = (response.body.dependencies as Array<{ name: string }>).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['database', 'redis', 'object-storage']));
  });

  it('readiness exposes no storage topology or credentials', async () => {
    const response = await request(server()).get('/health/ready');
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/bucket|palcert-test|access|secret|:9000/i);
  });

  it('health endpoints are not behind the /api prefix', async () => {
    await request(server()).get('/api/v1/health/live').expect(404);
  });

  it('echoes a correlation id on every response', async () => {
    const response = await request(server())
      .get('/health/live')
      .set(REQUEST_ID_HEADER, 'e2e-correlation-id')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('e2e-correlation-id');
  });

  it('returns a structured PalCert error body for unknown routes', async () => {
    const response = await request(server()).get('/api/v1/does-not-exist').expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toEqual(expect.any(String));
  });

  it('sets the security baseline headers', async () => {
    const response = await request(server()).get('/health/live').expect(200);

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });
});
