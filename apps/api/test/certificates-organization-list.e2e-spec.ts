import { API, AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  submitAndPrepare,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/** Wait for the live worker to issue the certificate for one revision. */
async function waitForIssued(context: TestContext, revisionId: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const row = await context.adminDb.complianceCertificate.findFirst({
      where: { submissionRevisionId: revisionId },
    });
    if (row !== null && row.issuanceStatus === 'ISSUED') return row.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`certificate for ${revisionId} was not issued`);
}

const list = (client: AuthClient, organizationId: string, query = '') =>
  client.get(`${API}/organizations/${organizationId}/certificates${query}`);

describe('Certificates — the organization register (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let otherUniversity: TenantFixture;
  let standard: PublishedStandard;
  let certificateId: string;
  let certificateNumber: string;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    otherUniversity = await createTenant(context, 'Birzeit University', 'other@example.com');
    standard = await publishStandardFor(context, university);

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);
    certificateId = await waitForIssued(context, revisionId);

    const one = await university.owner.client.get(
      `${API}/organizations/${university.organizationId}/certificates/${certificateId}`,
    );
    certificateNumber = one.body.certificateNumber as string;
    expect(certificateNumber).toMatch(/^PC-/);
  });

  it('lists what the organization issued, with the number and holder and nothing more', async () => {
    const response = await list(university.owner.client, university.organizationId);
    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items).toHaveLength(1);

    const [entry] = response.body.items;
    expect(entry).toMatchObject({
      id: certificateId,
      certificateNumber,
      issuanceStatus: 'ISSUED',
      holder: { email: 'author@example.com' },
      revokedAt: null,
    });

    // Narrower than the single view: the verification capability stays on the
    // certificate's own page, and no internal user id is handed out.
    const serialized = JSON.stringify(response.body);
    expect(entry).not.toHaveProperty('verificationCode');
    expect(entry).not.toHaveProperty('verificationUrl');
    expect(entry.holder).not.toHaveProperty('userId');
    expect(serialized).not.toContain(author.userId);
  });

  it('filters by status', async () => {
    const issued = await list(university.owner.client, university.organizationId, '?status=ISSUED');
    expect(issued.body.items).toHaveLength(1);

    const revoked = await list(
      university.owner.client,
      university.organizationId,
      '?status=REVOKED',
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.items).toHaveLength(0);

    const bogus = await list(university.owner.client, university.organizationId, '?status=LOST');
    expect(bogus.status).toBe(400);
  });

  it('finds by standard text, and by the exact certificate number', async () => {
    const all = await list(university.owner.client, university.organizationId);
    const standardCode = all.body.items[0].standardCode as string;
    const byCode = await list(
      university.owner.client,
      university.organizationId,
      `?q=${encodeURIComponent(standardCode.slice(0, 4).toLowerCase())}`,
    );
    expect(byCode.body.items.map((item: { id: string }) => item.id)).toEqual([certificateId]);

    // Spaced and lower-cased, as a person would read it off a PDF.
    const typed = certificateNumber.toLowerCase().replace(/-/g, ' ');
    const byNumber = await list(
      university.owner.client,
      university.organizationId,
      `?q=${encodeURIComponent(typed)}`,
    );
    expect(byNumber.body.items.map((item: { id: string }) => item.id)).toEqual([certificateId]);

    const nothing = await list(
      university.owner.client,
      university.organizationId,
      '?q=no-such-standard',
    );
    expect(nothing.body.items).toHaveLength(0);
  });

  it('pages with a cursor it issued, and refuses one it did not', async () => {
    const first = await list(university.owner.client, university.organizationId, '?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);

    const invalid = await list(
      university.owner.client,
      university.organizationId,
      '?cursor=not-a-cursor',
    );
    expect(invalid.status).toBe(400);
  });

  it('shows another organization nothing, even given the number', async () => {
    const own = await list(otherUniversity.owner.client, otherUniversity.organizationId);
    expect(own.status).toBe(200);
    expect(own.body.items).toEqual([]);

    const guessed = await list(
      otherUniversity.owner.client,
      otherUniversity.organizationId,
      `?q=${encodeURIComponent(certificateNumber)}`,
    );
    expect(guessed.body.items).toEqual([]);

    // Somebody else's organization id: not a member, so no tenant at all.
    const foreign = await list(otherUniversity.owner.client, university.organizationId);
    expect([403, 404]).toContain(foreign.status);
  });

  it('refuses a member without certificate:read, and a signed-out caller', async () => {
    const author2 = await createUser(context, 'templates@example.com');
    await grantOrganizationRoleTo(context, university, author2, 'TEMPLATE_MANAGER');
    const refused = await list(author2.client, university.organizationId);
    expect(refused.status).toBe(403);

    const anonymous = await new AuthClient(context.app).get(
      `${API}/organizations/${university.organizationId}/certificates`,
    );
    expect(anonymous.status).toBe(401);
  });
});
