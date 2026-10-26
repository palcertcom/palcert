import { PrismaClient } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import { applyTestEnvironment } from './support/test-environment';

/**
 * Connection-pool tenant safety (§18, §69, §70).
 *
 * These are the tests that justify the whole transaction-local design. The
 * failure they defend against is invisible in ordinary application tests: a
 * request establishes tenant context on a pooled connection, the connection
 * goes back to the pool still carrying it, and the next request — for a
 * different tenant — inherits it.
 *
 * The pool is deliberately capped at ONE connection, so every statement below
 * is guaranteed to reuse the same physical connection. Without that, a passing
 * result would prove nothing.
 */
describe('Tenant isolation — connection pooling', () => {
  let restoreEnv: () => void;
  let admin: PrismaClient;
  let app: PrismaClient;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    restoreEnv = applyTestEnvironment();

    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL! } } });

    // connection_limit=1 forces reuse of a single backend for every query.
    const singleConnectionUrl = new URL(process.env.DATABASE_URL!);
    singleConnectionUrl.searchParams.set('connection_limit', '1');
    singleConnectionUrl.searchParams.set('pool_timeout', '20');
    app = new PrismaClient({ datasources: { db: { url: singleConnectionUrl.toString() } } });

    await Promise.all([admin.$connect(), app.$connect()]);

    await admin.$executeRawUnsafe('SET row_security = off');
    await admin.$executeRaw`
      INSERT INTO users (id, email, normalized_email, password_hash, password_algorithm, status, email_verified_at, updated_at)
      VALUES (${userA}::uuid, 'pool-a@example.com', 'pool-a@example.com', 'h', 'argon2id', 'ACTIVE', NOW(), NOW()),
             (${userB}::uuid, 'pool-b@example.com', 'pool-b@example.com', 'h', 'argon2id', 'ACTIVE', NOW(), NOW())
    `;
    await admin.$executeRaw`
      INSERT INTO organizations (id, type, legal_name, display_name, slug, country_code, timezone, created_by_user_id, updated_at)
      VALUES (${orgA}::uuid, 'UNIVERSITY', 'Pool A', 'Pool A', 'pool-a-org', 'PS', 'Asia/Hebron', ${userA}::uuid, NOW()),
             (${orgB}::uuid, 'PUBLISHER', 'Pool B', 'Pool B', 'pool-b-org', 'PS', 'Asia/Hebron', ${userB}::uuid, NOW())
    `;
    await admin.$executeRaw`
      INSERT INTO organization_memberships (id, organization_id, user_id, updated_at)
      VALUES (gen_random_uuid(), ${orgA}::uuid, ${userA}::uuid, NOW()),
             (gen_random_uuid(), ${orgB}::uuid, ${userB}::uuid, NOW())
    `;
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe('SET row_security = off');
    await admin.$executeRaw`DELETE FROM organizations WHERE id IN (${orgA}::uuid, ${orgB}::uuid)`;
    await admin.$executeRaw`DELETE FROM users WHERE id IN (${userA}::uuid, ${userB}::uuid)`;
    await Promise.all([admin.$disconnect(), app.$disconnect()]);
    restoreEnv();
  });

  /** Mirrors TenantPrismaService: context is set transaction-locally. */
  async function asTenant<T>(
    organizationId: string | null,
    userId: string,
    work: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', ${organizationId ?? ''}, true)`;
      await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${userId}, true)`;
      await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'off', true)`;
      return work(tx as unknown as PrismaClient);
    });
  }

  async function visibleSlugs(organizationId: string | null, userId: string): Promise<string[]> {
    return asTenant(organizationId, userId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ slug: string }>
      >`SELECT slug FROM organizations ORDER BY slug`;
      return rows.map((row) => row.slug);
    });
  }

  it('does not carry tenant context into the next request on the same connection', async () => {
    // Tenant A, then tenant B, then an unscoped query — all on one connection.
    expect(await visibleSlugs(orgA, userA)).toEqual(['pool-a-org']);
    expect(await visibleSlugs(orgB, userB)).toEqual(['pool-b-org']);
    expect(await visibleSlugs(orgA, userA)).toEqual(['pool-a-org']);
  });

  it('leaves no tenant context behind after a transaction commits', async () => {
    await visibleSlugs(orgA, userA);

    const leaked = await app.$queryRaw<Array<{ org: string | null; usr: string | null }>>`
      SELECT NULLIF(current_setting('palcert.current_organization_id', true), '') AS org,
             NULLIF(current_setting('palcert.current_user_id', true), '') AS usr
    `;

    expect(leaked[0]?.org).toBeNull();
    expect(leaked[0]?.usr).toBeNull();
  });

  it('leaves no tenant context behind after a transaction ROLLS BACK', async () => {
    // The dangerous case: an aborted request must not poison the connection.
    await expect(
      asTenant(orgA, userA, async (tx) => {
        await tx.$queryRaw`SELECT slug FROM organizations`;
        throw new Error('deliberate failure inside the tenant transaction');
      }),
    ).rejects.toThrow('deliberate failure');

    const leaked = await app.$queryRaw<Array<{ org: string | null }>>`
      SELECT NULLIF(current_setting('palcert.current_organization_id', true), '') AS org
    `;
    expect(leaked[0]?.org).toBeNull();

    // And the next tenant on the same connection sees only its own data.
    expect(await visibleSlugs(orgB, userB)).toEqual(['pool-b-org']);
  });

  it('shows nothing at all to a query with no tenant context', async () => {
    await visibleSlugs(orgA, userA);

    const rows = await app.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM organizations`;
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('keeps tenants separate under interleaved concurrent transactions', async () => {
    const results = await Promise.all([
      visibleSlugs(orgA, userA),
      visibleSlugs(orgB, userB),
      visibleSlugs(orgA, userA),
      visibleSlugs(orgB, userB),
    ]);

    expect(results).toEqual([['pool-a-org'], ['pool-b-org'], ['pool-a-org'], ['pool-b-org']]);
  });

  it('does not let platform elevation persist past its transaction', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'on', true)`;
      const rows = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM organizations`;
      // Elevation genuinely works inside its own transaction...
      expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2);
    });

    // ...and is gone immediately afterwards.
    const after = await app.$queryRaw<Array<{ elevated: boolean }>>`
      SELECT app_is_platform_admin() AS elevated
    `;
    expect(after[0]?.elevated).toBe(false);

    expect(await visibleSlugs(orgA, userA)).toEqual(['pool-a-org']);
  });
});

/**
 * Direct database escape (§70).
 *
 * The scenario: a developer writes an ordinary-looking unscoped query in a
 * request path — the exact mistake application-level authorization tests cannot
 * catch, because the application never intended to check anything. RLS is what
 * makes that mistake harmless.
 */
describe('Tenant isolation — unscoped query containment', () => {
  let restoreEnv: () => void;
  let admin: PrismaClient;
  let app: PrismaClient;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    restoreEnv = applyTestEnvironment();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL! } } });
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    await Promise.all([admin.$connect(), app.$connect()]);

    await admin.$executeRawUnsafe('SET row_security = off');
    await admin.$executeRaw`
      INSERT INTO users (id, email, normalized_email, password_hash, password_algorithm, status, email_verified_at, updated_at)
      VALUES (${userA}::uuid, 'esc-a@example.com', 'esc-a@example.com', 'h', 'argon2id', 'ACTIVE', NOW(), NOW()),
             (${userB}::uuid, 'esc-b@example.com', 'esc-b@example.com', 'h', 'argon2id', 'ACTIVE', NOW(), NOW())
    `;
    await admin.$executeRaw`
      INSERT INTO organizations (id, type, legal_name, display_name, slug, country_code, timezone, created_by_user_id, updated_at)
      VALUES (${orgA}::uuid, 'UNIVERSITY', 'Escape A', 'Escape A', 'escape-a', 'PS', 'Asia/Hebron', ${userA}::uuid, NOW()),
             (${orgB}::uuid, 'PUBLISHER', 'Escape B', 'Escape B', 'escape-b', 'PS', 'Asia/Hebron', ${userB}::uuid, NOW())
    `;
    await admin.$executeRaw`
      INSERT INTO organization_memberships (id, organization_id, user_id, updated_at)
      VALUES (gen_random_uuid(), ${orgA}::uuid, ${userA}::uuid, NOW()),
             (gen_random_uuid(), ${orgB}::uuid, ${userB}::uuid, NOW())
    `;
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe('SET row_security = off');
    await admin.$executeRaw`DELETE FROM organizations WHERE id IN (${orgA}::uuid, ${orgB}::uuid)`;
    await admin.$executeRaw`DELETE FROM users WHERE id IN (${userA}::uuid, ${userB}::uuid)`;
    await Promise.all([admin.$disconnect(), app.$disconnect()]);
    restoreEnv();
  });

  async function inTenantA<T>(work: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', ${orgA}, true)`;
      await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${userA}, true)`;
      return work(tx as unknown as PrismaClient);
    });
  }

  it('constrains a forgotten WHERE clause on organizations', async () => {
    const rows = await inTenantA(
      async (tx) => tx.$queryRaw<Array<{ slug: string }>>`SELECT slug FROM organizations`,
    );
    expect(rows.map((row) => row.slug)).toEqual(['escape-a']);
  });

  it('constrains a forgotten WHERE clause on memberships', async () => {
    const rows = await inTenantA(
      async (tx) =>
        tx.$queryRaw<
          Array<{ organization_id: string }>
        >`SELECT organization_id FROM organization_memberships`,
    );
    expect(rows.every((row) => row.organization_id === orgA)).toBe(true);
  });

  it('constrains an UPDATE that names another tenant explicitly', async () => {
    await inTenantA(async (tx) => {
      await tx.$executeRaw`UPDATE organizations SET display_name = 'HIJACKED' WHERE id = ${orgB}::uuid`;
    });

    const [row] = await admin.$queryRaw<Array<{ display_name: string }>>`
      SELECT display_name FROM organizations WHERE id = ${orgB}::uuid
    `;
    expect(row?.display_name).toBe('Escape B');
  });

  it('constrains a DELETE that names another tenant explicitly', async () => {
    await inTenantA(async (tx) => {
      await tx.$executeRaw`DELETE FROM organization_memberships WHERE organization_id = ${orgB}::uuid`;
    });

    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM organization_memberships WHERE organization_id = ${orgB}::uuid
    `;
    expect(Number(row!.count)).toBe(1);
  });

  it('refuses an INSERT into another tenant', async () => {
    await expect(
      inTenantA(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO organization_memberships (id, organization_id, user_id, updated_at)
          VALUES (gen_random_uuid(), ${orgB}::uuid, ${userA}::uuid, NOW())
        `;
      }),
    ).rejects.toThrow();
  });

  it('hides another tenant even from an aggregate, so existence cannot be inferred', async () => {
    const rows = await inTenantA(
      async (tx) =>
        tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM organizations WHERE id = ${orgB}::uuid
      `,
    );
    // An aggregate is the classic side channel: a count of 1 would confirm the
    // organization exists without ever returning a row.
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('hides another tenant from a join', async () => {
    const rows = await inTenantA(
      async (tx) =>
        tx.$queryRaw<Array<{ slug: string }>>`
        SELECT o.slug
        FROM organizations o
        JOIN organization_memberships m ON m.organization_id = o.id
      `,
    );
    expect(rows.map((row) => row.slug)).toEqual(['escape-a']);
  });
});
