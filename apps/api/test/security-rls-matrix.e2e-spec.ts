import { PrismaClient } from '@palcert/database';
import { publishCheckableStandard, startCheck, waitForCheck } from './support/checks-client';
import { createApiClient } from './support/api-client-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { fundBalance } from './support/finance-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Cross-tenant isolation, asked of the database rather than of the API
 * (Phase 20 Checkpoint 7).
 *
 * The existing isolation suites drive HTTP, which proves the guards work. It
 * does not prove *isolation* — a guard is one `if` away from being wrong, and
 * an ORM query missing a `where` clause passes straight through it. Row-level
 * security is the control that holds when the layer above is mistaken, and the
 * only way to test it is to become the role the API connects as and ask the
 * database directly.
 *
 * Three domains are covered here because they had no such proof: private
 * checks, finance, and API clients. Documents are included as the fourth,
 * since the same fixture produces them. Submissions, certificates, webhooks
 * and notifications already have application-role SQL suites of their own
 * (`submissions-database`, `certificates-database`, `webhooks-system-authority`,
 * `notifications-database`), and `tenant-rls-coverage` separately proves every
 * tenant-scoped table has row-level security enabled *and* forced *and*
 * carrying a policy.
 *
 * Every fixture here is built through the real HTTP workflows. Inserting rows
 * with the admin role would test the policy expression against data that never
 * went through the code that writes it.
 */

/** The three session settings the request pipeline sets, and nothing else. */
async function asTenant<T>(
  app: PrismaClient,
  identity: { organizationId: string | null; userId: string },
  work: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', ${identity.organizationId ?? ''}, true)`;
    await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${identity.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'off', true)`;
    return work(tx as unknown as PrismaClient);
  });
}

async function countVisible(
  app: PrismaClient,
  identity: { organizationId: string | null; userId: string },
  table: string,
  id: string,
): Promise<number> {
  return asTenant(app, identity, async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM ${table} WHERE id = $1::uuid`,
      id,
    );
    return Number(rows[0]?.count ?? 0n);
  });
}

describe('Cross-tenant isolation at the database (e2e)', () => {
  let context: TestContext;
  let app: PrismaClient;

  let owner: { userId: string; client: Awaited<ReturnType<typeof createUser>>['client'] };
  let stranger: { userId: string; client: Awaited<ReturnType<typeof createUser>>['client'] };
  let tenantA: Awaited<ReturnType<typeof createTenant>>;
  let tenantB: Awaited<ReturnType<typeof createTenant>>;

  const rows: Record<string, string> = {};

  /** The fixture id for a table, refusing rather than silently testing `undefined`. */
  function idFor(table: string): string {
    const id = rows[table];
    if (id === undefined) throw new Error(`no fixture row was recorded for ${table}`);
    return id;
  }

  beforeAll(async () => {
    context = await createTestContext();
    await resetState(context);

    // The role the API actually connects as. `context.prisma` is the same
    // role, but it is the application's client and carries the application's
    // context handling; a separate client makes the session settings — and
    // their absence — explicit.
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    await app.$connect();

    const ownerUser = await createUser(context, 'matrix-owner@example.com');
    const strangerUser = await createUser(context, 'matrix-stranger@example.com');
    owner = { userId: ownerUser.userId, client: ownerUser.client };
    stranger = { userId: strangerUser.userId, client: strangerUser.client };

    tenantA = await createTenant(context, 'Matrix University A', 'matrix-registrar-a@example.com');
    tenantB = await createTenant(context, 'Matrix University B', 'matrix-registrar-b@example.com');

    // --- a document and a completed check, owned by `owner` ----------------
    const standard = await publishCheckableStandard(
      context,
      tenantA.owner.client,
      tenantA.organizationId,
    );
    const document = await createDocument(owner.client, 'Matrix Thesis');
    rows.documents = document.id;
    const { versionId } = await uploadAndProcess(owner.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await startCheck(context, owner, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);
    rows.document_checks = created.body.id as string;

    const run = await context.adminDb.checkRun.findFirst({
      where: { checkId: rows.document_checks },
      select: { id: true },
    });
    if (run === null) throw new Error('the fixture check produced no run');
    rows.check_runs = run.id;

    // --- money, owned by `owner` -------------------------------------------
    await fundBalance(context, owner.client, '5000');
    const account = await context.adminDb.customerCreditAccount.findFirst({
      where: { ownerUserId: owner.userId },
      select: { id: true },
    });
    const entry = await context.adminDb.creditLedgerEntry.findFirst({
      where: { ownerUserId: owner.userId },
      select: { id: true },
    });
    if (account === null || entry === null) throw new Error('the fixture produced no ledger');
    rows.customer_credit_accounts = account.id;
    rows.credit_ledger_entries = entry.id;

    // --- an API client, owned by tenant A ----------------------------------
    const client = await createApiClient(
      context.app,
      tenantA.owner.client,
      tenantA.organizationId,
      ['organization:read'],
      { displayName: 'Matrix Integration' },
    );
    rows.api_clients = client.apiClientId;
  }, 180_000);

  afterAll(async () => {
    await app.$disconnect();
    await destroyTestContext(context);
  });

  it('created a row in every table it is about to test', () => {
    // Without this the whole file passes vacuously if a fixture step silently
    // produced nothing: "the stranger sees zero rows" is also true when there
    // are no rows.
    for (const [table, id] of Object.entries(rows)) {
      expect(typeof id === 'string' && id.length > 0).toBe(true);
      expect(table).not.toBe('');
    }
    expect(Object.keys(rows).sort()).toEqual([
      'api_clients',
      'check_runs',
      'credit_ledger_entries',
      'customer_credit_accounts',
      'document_checks',
      'documents',
    ]);
  });

  describe('owner-scoped tables', () => {
    const ownerScoped = [
      'documents',
      'document_checks',
      'check_runs',
      'customer_credit_accounts',
      'credit_ledger_entries',
    ] as const;

    it.each(ownerScoped)('%s: the owner sees the row', async (table) => {
      // The control. Every "sees nothing" assertion below is worthless without
      // it — a broken connection, a mistyped table or an empty fixture all
      // produce zero rows too.
      expect(
        await countVisible(
          app,
          { organizationId: null, userId: owner.userId },
          table,
          idFor(table),
        ),
      ).toBe(1);
    });

    it.each(ownerScoped)('%s: another user sees nothing', async (table) => {
      expect(
        await countVisible(
          app,
          { organizationId: null, userId: stranger.userId },
          table,
          idFor(table),
        ),
      ).toBe(0);
    });

    it.each(ownerScoped)('%s: an organization the owner deals with sees nothing', async (table) => {
      // The university whose standard the document was checked against. It
      // published the rules; that buys it no sight of the work.
      expect(
        await countVisible(
          app,
          { organizationId: tenantA.organizationId, userId: tenantA.owner.userId },
          table,
          idFor(table),
        ),
      ).toBe(0);
    });

    it.each(ownerScoped)('%s: no context at all sees nothing', async (table) => {
      expect(
        await countVisible(
          app,
          { organizationId: null, userId: '00000000-0000-4000-8000-000000000000' },
          table,
          idFor(table),
        ),
      ).toBe(0);
    });
  });

  describe('organization-scoped tables', () => {
    it('api_clients: the owning organization sees its own', async () => {
      expect(
        await countVisible(
          app,
          { organizationId: tenantA.organizationId, userId: tenantA.owner.userId },
          'api_clients',
          idFor('api_clients'),
        ),
      ).toBe(1);
    });

    it('api_clients: another organization sees nothing', async () => {
      expect(
        await countVisible(
          app,
          { organizationId: tenantB.organizationId, userId: tenantB.owner.userId },
          'api_clients',
          idFor('api_clients'),
        ),
      ).toBe(0);
    });

    it('api_clients: a member of neither organization sees nothing', async () => {
      expect(
        await countVisible(
          app,
          { organizationId: null, userId: stranger.userId },
          'api_clients',
          idFor('api_clients'),
        ),
      ).toBe(0);
    });
  });

  describe('the secret material behind an API client', () => {
    it('is never visible to another organization', async () => {
      // `api_client_secrets` holds the verifier for a credential. A row leak
      // here is worse than a metadata leak, so it is asked separately rather
      // than assumed to follow from the parent table.
      const visible = await asTenant(
        app,
        { organizationId: tenantB.organizationId, userId: tenantB.owner.userId },
        async (tx) =>
          tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM api_client_secrets
            WHERE api_client_id = ${idFor('api_clients')}::uuid`,
      );
      expect(Number(visible[0]?.count ?? 0n)).toBe(0);
    });
  });
});
