import type { AccountReportView } from '@palcert/contracts';
import { CreditClass } from '@palcert/contracts';
import { API, AuthClient } from './support/auth-client';
import { createUser, createTenant, signInPlatformAdmin } from './support/organization-client';
import { grantCredit } from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
const range = 'from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&locale=en&timeZone=UTC';
describe('Account reports authorization, totals and downloads (e2e)', () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await createTestContext();
  });
  afterAll(async () => {
    await destroyTestContext(context);
  });
  beforeEach(async () => {
    await resetState(context);
  });
  it('keeps users and currencies apart and exports all pages without silent truncation', async () => {
    const alice = await createUser(context, 'report-alice@example.test');
    const bob = await createUser(context, 'report-bob@example.test');
    await grantCredit(context, bob.userId, 999999n);
    for (let i = 0; i < 51; i++) await grantCredit(context, alice.userId, 100n);
    await grantCredit(context, alice.userId, 222n, CreditClass.PROMOTIONAL);
    await grantCredit(context, alice.userId, 3001n, CreditClass.CASH, 'JOD');
    const result = await alice.client.get(`${API}/reports?kind=financial&${range}`);
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toContain('no-store');
    const view = result.body as AccountReportView;
    expect(view.total).toBe(53);
    expect(view.detail.rows).toHaveLength(50);
    expect(view.nextOffset).toBe(50);
    expect(view.summaries[0]!.rows).toEqual(
      expect.arrayContaining([
        ['USD', 'CASH', '0.00', '51.00', '0.00', '51.00'],
        ['USD', 'PROMOTIONAL', '0.00', '2.22', '0.00', '2.22'],
        ['JOD', 'CASH', '0.000', '3.001', '0.000', '3.001'],
      ]),
    );
    const full = await alice.client.get(`${API}/reports/print?kind=financial&${range}&offset=50`);
    expect(full.status).toBe(200);
    expect(full.body.detail.rows).toHaveLength(53);
    expect(full.body.offset).toBe(0);
    expect(full.body.nextOffset).toBeNull();
    const pdf = await alice.client.get(`${API}/reports/pdf?kind=financial&${range}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment;');
    expect(
      (await alice.client.get(`${API}/reports?kind=financial&${range}&ownerUserId=${bob.userId}`))
        .status,
    ).toBe(400);
  });
  it('authorizes JSON, print and PDF identically and validates filters', async () => {
    const user = await createUser(context, 'report-user@example.test');
    const institution = await createTenant(
      context,
      'Report University',
      'report-owner@example.test',
    );
    const anonymous = new AuthClient(context.app);
    for (const suffix of ['', '/print', '/pdf']) {
      expect((await anonymous.get(`${API}/reports${suffix}?kind=financial&${range}`)).status).toBe(
        401,
      );
      expect(
        (await user.client.get(`${API}/admin/reports${suffix}?kind=financial&${range}`)).status,
      ).toBe(403);
      const foreign = await user.client.get(
        `${API}/organizations/${institution.organizationId}/reports${suffix}?kind=services&${range}`,
      );
      // Tenant resolution hides inaccessible institutions, just like missing ones.
      // Check the domain error too, so a missing report route cannot satisfy this assertion.
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    }
    expect(
      (await user.client.get(`${API}/reports?kind=financial&${range}&service=DOCUMENT_CHECK`))
        .status,
    ).toBe(400);
    expect(
      (await user.client.get(`${API}/reports?kind=services&${range}&service=INVALID`)).status,
    ).toBe(400);
    expect(
      (
        await user.client.get(
          `${API}/reports?kind=financial&from=2020-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`,
        )
      ).status,
    ).toBe(400);
    const admin = await signInPlatformAdmin(context, 'report-admin@example.test');
    const platform = await admin.get(`${API}/admin/reports?kind=financial&${range}`);
    expect(platform.status).toBe(200);
    expect(platform.body.total).toBe(0);
    const own = await institution.owner.client.get(
      `${API}/organizations/${institution.organizationId}/reports?kind=services&${range}`,
    );
    expect(own.status).toBe(200);
    expect(own.body.total).toBe(0);
  });
});
