import { PrismaClient } from '@palcert/database';
import { applyTestEnvironment } from './support/test-environment';

interface TableClassification {
  table_name: string;
  classification: string;
  tenant_column: string | null;
}

interface TableSecurity {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
}

interface RolePrivileges {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * Schema-level isolation assertions (§20, §68).
 *
 * These read the PostgreSQL catalogue rather than a hand-maintained list, so a
 * tenant table added in a later phase without isolation fails CI instead of
 * quietly shipping. That is the whole point: the failure mode being defended
 * against is a future developer forgetting, not this phase getting it wrong.
 */
describe('Tenant isolation — schema coverage', () => {
  let restoreEnv: () => void;
  let admin: PrismaClient;
  let app: PrismaClient;

  let classifications: TableClassification[];
  let security: TableSecurity[];
  let policies: PolicyRow[];

  beforeAll(async () => {
    restoreEnv = applyTestEnvironment();

    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL! } } });
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    await Promise.all([admin.$connect(), app.$connect()]);

    classifications = await admin.$queryRaw<TableClassification[]>`
      SELECT table_name, classification, tenant_column FROM table_isolation_classification
    `;
    security = await admin.$queryRaw<TableSecurity[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    `;
    policies = await admin.$queryRaw<PolicyRow[]>`
      SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public'
    `;
  });

  afterAll(async () => {
    await Promise.all([admin.$disconnect(), app.$disconnect()]);
    restoreEnv();
  });

  it('classifies every table in the schema', () => {
    const classified = new Set(classifications.map((row) => row.table_name));
    const unclassified = security.map((row) => row.relname).filter((name) => !classified.has(name));

    // A new table must declare how it is isolated. If this fails, add a row to
    // table_isolation_classification in the migration that created the table.
    expect(unclassified).toEqual([]);
  });

  it('does not classify tables that no longer exist', () => {
    const existing = new Set(security.map((row) => row.relname));
    const stale = classifications
      .map((row) => row.table_name)
      .filter((name) => !existing.has(name));

    expect(stale).toEqual([]);
  });

  it('enables and FORCES row-level security on every tenant-scoped table', () => {
    const tenantTables = classifications
      .filter((row) => row.classification === 'TENANT_SCOPED')
      .map((row) => row.table_name);

    expect(tenantTables.length).toBeGreaterThan(0);

    const missing = tenantTables.filter((name) => {
      const row = security.find((entry) => entry.relname === name);
      // FORCE matters because the tables are owned by the migration role, and
      // PostgreSQL exempts an owner from its own policies unless forced.
      return row === undefined || !row.relrowsecurity || !row.relforcerowsecurity;
    });

    expect(missing).toEqual([]);
  });

  it('gives every tenant-scoped table policies covering all four commands', () => {
    const tenantTables = classifications
      .filter((row) => row.classification === 'TENANT_SCOPED')
      .map((row) => row.table_name);

    const uncovered: string[] = [];

    for (const table of tenantTables) {
      const tablePolicies = policies.filter((policy) => policy.tablename === table);
      const commands = new Set(tablePolicies.map((policy) => policy.cmd));

      // An ALL policy covers every command; otherwise each must be present.
      const covered =
        commands.has('ALL') ||
        (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).every((cmd) => commands.has(cmd));

      if (!covered) uncovered.push(`${table} (${[...commands].join(',') || 'none'})`);
    }

    expect(uncovered).toEqual([]);
  });

  // --- User-scoped tables with an owner column (Phase 5, ADR-0031) -----------
  //
  // Documents are private to a person, not to a tenant. The same mechanism
  // applies — RLS on the owner column — so the same guarantees are demanded:
  // a USER_SCOPED table that names its isolation column must be enabled,
  // forced, fully policied and WITH CHECK-protected, exactly like a tenant
  // table. A USER_SCOPED table without one (users, sessions) is guarded by
  // application authorization, as Phase 2 decided.

  const ownerScopedTables = (): string[] =>
    classifications
      .filter((row) => row.classification === 'USER_SCOPED' && row.tenant_column !== null)
      .map((row) => row.table_name);

  it('has owner-scoped document tables', () => {
    expect(ownerScopedTables()).toEqual(
      expect.arrayContaining([
        'documents',
        'document_versions',
        'upload_sessions',
        'document_retention_locks',
      ]),
    );
  });

  it('enables and FORCES row-level security on every owner-scoped table', () => {
    const missing = ownerScopedTables().filter((name) => {
      const row = security.find((entry) => entry.relname === name);
      return row === undefined || !row.relrowsecurity || !row.relforcerowsecurity;
    });
    expect(missing).toEqual([]);
  });

  it('gives every owner-scoped table policies covering all four commands', () => {
    const uncovered = ownerScopedTables().filter((table) => {
      const commands = new Set(
        policies.filter((policy) => policy.tablename === table).map((policy) => policy.cmd),
      );
      return !(
        commands.has('ALL') ||
        (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).every((cmd) => commands.has(cmd))
      );
    });
    expect(uncovered).toEqual([]);
  });

  it('confines owner-scoped writes with WITH CHECK on the declared isolation column', async () => {
    // The column comes from the classification row rather than being spelled
    // 'owner_user_id' here, because the isolation column is whatever the table
    // declared — `user_notifications` isolates on `recipient_user_id` and
    // `notification_preferences` on `user_id`. Reading it from the catalogue
    // makes the assertion stronger, not weaker: it now checks each table
    // against its own declaration instead of against one hard-coded name.
    const writePolicies = await admin.$queryRaw<
      Array<{ tablename: string; tenant_column: string; with_check: string | null }>
    >`
      SELECT p.tablename, c.tenant_column, p.with_check
      FROM pg_policies p
      JOIN table_isolation_classification c ON c.table_name = p.tablename
      WHERE c.classification = 'USER_SCOPED' AND c.tenant_column IS NOT NULL
        AND p.cmd IN ('INSERT', 'UPDATE', 'ALL')
    `;
    expect(writePolicies.length).toBeGreaterThan(0);
    for (const policy of writePolicies) {
      // The one alternative, and it is narrower rather than wider: a row
      // written for somebody who is not the caller cannot be confined to the
      // caller's own id, so fan-out goes through a SECURITY DEFINER function
      // and the policy admits that writer alone. Phase 14 makes the same
      // allowance for the submission system writer.
      const confined =
        policy.with_check?.includes(policy.tenant_column) === true ||
        policy.with_check?.includes('app_is_notification_system_writer()') === true;
      expect([policy.tablename, policy.with_check, confined]).toEqual([
        policy.tablename,
        policy.with_check,
        true,
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Dual-party tables (Phase 14)
  //
  // The fifth classification, and the only one where two unrelated parties
  // legitimately read the same row. It exists because neither USER_SCOPED nor
  // TENANT_SCOPED describes an official submission, and a classification that
  // lies is worse than none — so these assertions are what make the new class
  // mean something rather than be a label.
  // -------------------------------------------------------------------------

  const dualPartyTables = (): string[] =>
    classifications
      .filter((row) => row.classification === 'DUAL_PARTY_SCOPED')
      .map((row) => row.table_name);

  it('classifies the official submission, certificate and attestation tables as dual-party', () => {
    // Certificates join the class for the same reason submissions did: the
    // subject and the approving organization both legitimately read them, and
    // neither may write them. Attestations are the same shape: the user who
    // submitted the certificate and the institution that attests it.
    expect(dualPartyTables().sort()).toEqual([
      'attestation_artifacts',
      'attestation_reminders',
      'attestation_request_events',
      'attestation_requests',
      'attestation_revenue_entries',
      'attestation_settlements',
      'attestations',
      'certificate_events',
      'compliance_certificates',
      'official_submissions',
      'submission_comments',
      'submission_decision_events',
      'submission_revisions',
    ]);
  });

  it('names an owner column on every dual-party table', () => {
    // A dual-party table must say who its author is, exactly as a tenant table
    // must say who its tenant is. Without it the policy below has nothing to
    // confine writes to.
    const unnamed = classifications.filter(
      (row) => row.classification === 'DUAL_PARTY_SCOPED' && row.tenant_column === null,
    );
    expect(unnamed).toEqual([]);
  });

  it('enables and FORCES row-level security on every dual-party table', () => {
    const missing = dualPartyTables().filter((name) => {
      const row = security.find((entry) => entry.relname === name);
      return row === undefined || !row.relrowsecurity || !row.relforcerowsecurity;
    });
    expect(missing).toEqual([]);
  });

  it('gives every dual-party table a read policy and never a blanket one', () => {
    // Deliberately not "all four commands". `FOR ALL` is the wrong shape here:
    // it would say the two parties have the same authority over the row, and
    // they do not. Read is shared; writing is not, and DELETE belongs to
    // nobody at all.
    const wrong = dualPartyTables().filter((table) => {
      const commands = policies
        .filter((policy) => policy.tablename === table)
        .map((policy) => policy.cmd);
      return commands.includes('ALL') || !commands.includes('SELECT');
    });
    expect(wrong).toEqual([]);
  });

  it('never gives a dual-party table a DELETE policy', () => {
    const deletable = dualPartyTables().filter((table) =>
      policies.some((policy) => policy.tablename === table && policy.cmd === 'DELETE'),
    );
    expect(deletable).toEqual([]);
  });

  it('lets only the author insert a submission, a revision or nothing at all', async () => {
    // The asymmetry the class rests on, checked per table rather than in
    // aggregate: the author creates the handoff, and the institution's INSERT
    // authority is confined to its own decisions and its own comments — each
    // of which must also carry the caller's own id, so a decision cannot be
    // attributed to somebody who did not make it.
    const inserts = await admin.$queryRaw<Array<{ tablename: string; with_check: string | null }>>`
      SELECT p.tablename, p.with_check
      FROM pg_policies p
      JOIN table_isolation_classification c ON c.table_name = p.tablename
      WHERE c.classification = 'DUAL_PARTY_SCOPED' AND p.cmd = 'INSERT'
    `;

    const checksFor = (table: string): string[] =>
      inserts.filter((row) => row.tablename === table).map((row) => row.with_check ?? '');

    for (const table of ['official_submissions', 'submission_revisions']) {
      const checks = checksFor(table);
      expect([table, checks.length]).toEqual([table, 1]);
      for (const check of checks) {
        expect([table, check]).toEqual([table, expect.stringContaining('owner_user_id')]);
        expect([table, check]).toEqual([
          table,
          expect.not.stringContaining('app_current_organization()'),
        ]);
      }
    }

    for (const table of ['submission_decision_events', 'submission_comments']) {
      const checks = checksFor(table);
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        // Either the institution writing as itself, or PalCert's own
        // finalisation — which is reachable only from inside the SECURITY
        // DEFINER function and only ever writes the one SYSTEM event.
        const institution =
          check.includes('app_current_organization()') && check.includes('app_current_user_id()');
        const system =
          check.includes('app_is_submission_system_writer()') && check.includes("'SYSTEM'");
        expect([table, check, institution || system]).toEqual([table, check, true]);
      }
      // The submitter is never one of the options.
      expect(checks.some((check) => /owner_user_id.*app_current_user_id/.test(check))).toBe(false);
    }
  });

  it('never lets either party rewrite institutional history', () => {
    // No UPDATE policy at all on the two append-only tables, and a trigger
    // underneath that refuses anyway. Two independent refusals, because one
    // of them being removed by accident should not be enough.
    const updatable = ['submission_decision_events', 'submission_comments'].filter((table) =>
      policies.some((policy) => policy.tablename === table && policy.cmd === 'UPDATE'),
    );
    expect(updatable).toEqual([]);
  });

  it('keeps the author’s private tables out of the dual-party class entirely', () => {
    // ADR-0031, restated as a test. The snapshot architecture exists so that
    // these never become organization-readable; a future phase that widened
    // one of them would have to delete this assertion to do it.
    const private_ = [
      'documents',
      'document_versions',
      'document_analyses',
      'document_checks',
      'check_runs',
      'check_reports',
      'ai_reviews',
      'smartfix_requests',
      'customer_credit_accounts',
      'service_purchases',
    ];
    for (const table of private_) {
      const row = classifications.find((entry) => entry.table_name === table);
      expect([table, row?.classification]).toEqual([table, 'USER_SCOPED']);
    }
  });

  it('names both parties in every dual-party read policy', async () => {
    // The whole point of the class: the author who submitted and the
    // organization they submitted to both read the row, and the policy says so
    // rather than the application remembering to.
    const readPolicies = await admin.$queryRaw<Array<{ tablename: string; qual: string | null }>>`
      SELECT p.tablename, p.qual
      FROM pg_policies p
      JOIN table_isolation_classification c ON c.table_name = p.tablename
      WHERE c.classification = 'DUAL_PARTY_SCOPED' AND p.cmd IN ('SELECT', 'ALL')
    `;
    expect(readPolicies.length).toBeGreaterThan(0);
    for (const policy of readPolicies) {
      expect([policy.tablename, policy.qual]).toEqual([
        policy.tablename,
        expect.stringContaining('owner_user_id'),
      ]);
      expect([policy.tablename, policy.qual]).toEqual([
        policy.tablename,
        expect.stringContaining('app_current_organization()'),
      ]);
    }
  });

  it("never lets an organization create a submission on an author's behalf", async () => {
    // The asymmetry that makes the class safe: the organization reads what it
    // was handed, and the author is the only party who can hand something
    // over. A submission the organization could write itself would be an
    // organization helping itself to a document (§25).
    const writePolicies = await admin.$queryRaw<
      Array<{ tablename: string; with_check: string | null }>
    >`
      SELECT p.tablename, p.with_check
      FROM pg_policies p
      JOIN table_isolation_classification c ON c.table_name = p.tablename
      WHERE c.classification = 'DUAL_PARTY_SCOPED'
        AND p.tablename IN ('official_submissions')
        AND p.cmd IN ('INSERT', 'UPDATE', 'ALL')
    `;
    expect(writePolicies.length).toBeGreaterThan(0);
    for (const policy of writePolicies) {
      expect(policy.with_check).toContain('owner_user_id');
      expect(policy.with_check).not.toContain('app_current_organization()');
    }
  });

  it('refuses to hard-delete institutional history', async () => {
    // §39: an official submission is audit history. The application role may
    // write it and may never remove it, so a product bug cannot erase the
    // record that a document was once handed to a university.
    const deletable = await admin.$queryRaw<Array<{ table_name: string }>>`
      SELECT c.table_name
      FROM table_isolation_classification c
      WHERE c.classification = 'DUAL_PARTY_SCOPED'
        AND has_table_privilege('palcert_app', c.table_name, 'DELETE')
    `;
    expect(deletable).toEqual([]);
  });

  it('keeps the private document and check tables out of the dual-party class', () => {
    // §77: submissions did not widen anything. Documents, versions, analyses,
    // checks, runs, results, violations, reports, AI reviews, SmartFix and
    // finance all keep the scopes they had before Phase 14.
    const stillPrivate = classifications.filter((row) =>
      [
        'documents',
        'document_versions',
        'document_analyses',
        'document_checks',
        'check_runs',
        'check_rule_results',
        'check_violations',
        'check_reports',
        'ai_reviews',
        'smartfix_requests',
        'smartfix_plans',
        'credit_ledger_entries',
      ].includes(row.table_name),
    );
    expect(stillPrivate.length).toBeGreaterThan(0);
    for (const row of stillPrivate) {
      expect([row.table_name, row.classification]).toEqual([row.table_name, 'USER_SCOPED']);
    }
  });

  it('keeps document tables free of any organization column', () => {
    // The product rule in schema form: a document is the uploader's, and no
    // organization owns one. `processing_jobs` is deliberately not in this
    // list — it is the shared job ledger rather than a document table, and
    // since Phase 9 it also carries organization-owned work. The guarantee
    // that matters for documents is asserted separately below.
    return admin.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id'
        AND table_name IN ('documents', 'document_versions', 'upload_sessions', 'document_retention_locks')
    `.then((rows) => expect(rows).toEqual([]));
  });

  it('never lets a document job carry an organization, or an organization job omit one', async () => {
    // The shared ledger serves both tenancy models, so the database decides
    // which each row may use rather than leaving it to whichever handler
    // enqueued it. A document job with an organization would be a job the
    // worker could run under the wrong scope entirely.
    const [constraint] = await admin.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'processing_jobs_tenancy_matches_type'
    `;
    expect(constraint).toBeDefined();
    expect(constraint!.definition).toContain('STANDARD_SOURCE_ASSET');
    expect(constraint!.definition).toContain('RULE_EXTRACTION_RUN');

    // And no stored row disagrees with it.
    const offenders = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM processing_jobs
      WHERE (resource_type IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')) <> (organization_id IS NOT NULL)
    `;
    expect(offenders).toEqual([]);
  });

  it('names a tenant column for every tenant-scoped table', () => {
    const missing = classifications
      .filter((row) => row.classification === 'TENANT_SCOPED' && row.tenant_column === null)
      .map((row) => row.table_name);

    expect(missing).toEqual([]);
  });

  it('protects new rows with a WITH CHECK clause on every write policy', async () => {
    const writePolicies = await admin.$queryRaw<
      Array<{ tablename: string; policyname: string; cmd: string; with_check: string | null }>
    >`
      SELECT p.tablename, p.policyname, p.cmd, p.with_check
      FROM pg_policies p
      JOIN table_isolation_classification c ON c.table_name = p.tablename
      WHERE c.classification = 'TENANT_SCOPED'
        AND p.cmd IN ('INSERT', 'UPDATE', 'ALL')
    `;

    expect(writePolicies.length).toBeGreaterThan(0);

    // Without WITH CHECK, a policy would let a row be written *into* another
    // tenant even while preventing it from being read back.
    const unprotected = writePolicies
      .filter((policy) => policy.with_check === null)
      .map((policy) => `${policy.tablename}.${policy.policyname}`);

    expect(unprotected).toEqual([]);
  });
});

describe('Tenant isolation — database roles', () => {
  let restoreEnv: () => void;
  let app: PrismaClient;

  beforeAll(async () => {
    restoreEnv = applyTestEnvironment();
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    await app.$connect();
  });

  afterAll(async () => {
    await app.$disconnect();
    restoreEnv();
  });

  it('runs the request path as a role that cannot bypass row-level security', async () => {
    const [privileges] = await app.$queryRaw<RolePrivileges[]>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = CURRENT_USER
    `;

    expect(privileges).toBeDefined();
    // The single most important assertion in this file: every policy is
    // decoration if either of these is true.
    expect(privileges!.rolsuper).toBe(false);
    expect(privileges!.rolbypassrls).toBe(false);
  });

  it('does not run the request path as the schema owner', async () => {
    const [row] = await app.$queryRaw<Array<{ is_owner: boolean }>>`
      SELECT (tableowner = CURRENT_USER) AS is_owner
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'organizations'
    `;

    // An owner would be exempt from its own policies were it not for FORCE RLS;
    // relying on FORCE alone would be one configuration slip from disaster.
    expect(row?.is_owner).toBe(false);
  });

  it('cannot disable row-level security on a tenant table', async () => {
    await expect(
      app.$executeRawUnsafe('ALTER TABLE organizations DISABLE ROW LEVEL SECURITY'),
    ).rejects.toThrow();
  });

  it('cannot drop a tenant isolation policy', async () => {
    await expect(
      app.$executeRawUnsafe('DROP POLICY organizations_select ON organizations'),
    ).rejects.toThrow();
  });

  it('cannot reclassify a table to escape the coverage test', async () => {
    await expect(
      app.$executeRawUnsafe(
        "UPDATE table_isolation_classification SET classification = 'GLOBAL' WHERE table_name = 'organizations'",
      ),
    ).rejects.toThrow();
  });

  it('cannot read the migration history', async () => {
    await expect(app.$queryRawUnsafe('SELECT * FROM _prisma_migrations')).rejects.toThrow();
  });

  it('cannot remove the published-immutability triggers', async () => {
    // These triggers are what makes a published standard version fixed even
    // against a bug in the service layer. The application must not be able to
    // take them off.
    for (const [trigger, table] of [
      ['standard_versions_freeze', 'standard_versions'],
      ['standard_rules_freeze', 'standard_rules'],
      ['standard_version_snapshots_append_only', 'standard_version_snapshots'],
    ] as const) {
      await expect(app.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON ${table}`)).rejects.toThrow();
    }
  });
});

/**
 * Phase 3 schema guarantees.
 *
 * These name the constructs explicitly, rather than only relying on the
 * catalogue-driven checks above, so that deleting one of them shows up as a
 * failure that says which one.
 */
describe('Standards schema guarantees', () => {
  let restoreEnv: () => void;
  let admin: PrismaClient;

  beforeAll(async () => {
    restoreEnv = applyTestEnvironment();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL! } } });
    await admin.$connect();
  });

  afterAll(async () => {
    await admin.$disconnect();
    restoreEnv();
  });

  it('classifies every Phase 3 table as tenant-scoped on organization_id', async () => {
    const rows = await admin.$queryRaw<TableClassification[]>`
      SELECT table_name, classification, tenant_column
      FROM table_isolation_classification
      WHERE table_name IN (
        'document_types', 'standards', 'standard_versions',
        'standard_rules', 'standard_version_snapshots'
      )
    `;

    expect(rows).toHaveLength(5);
    const misclassified = rows.filter(
      (row) => row.classification !== 'TENANT_SCOPED' || row.tenant_column !== 'organization_id',
    );
    expect(misclassified).toEqual([]);
  });

  it('carries a composite foreign key including organization_id on every child', async () => {
    // This is what makes cross-tenant parent injection a database error rather
    // than something the application must remember to check.
    const rows = await admin.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND conname IN (
        'standards_document_type_org_fkey',
        'standard_versions_standard_org_fkey',
        'standard_rules_version_org_fkey',
        'standard_version_snapshots_version_org_fkey',
        'standard_versions_cloned_from_org_fkey'
      )
    `;

    expect(rows.map((row) => row.conname).sort()).toEqual([
      'standard_rules_version_org_fkey',
      'standard_version_snapshots_version_org_fkey',
      'standard_versions_cloned_from_org_fkey',
      'standard_versions_standard_org_fkey',
      'standards_document_type_org_fkey',
    ]);
  });

  it('installs the published-immutability triggers', async () => {
    const rows = await admin.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN (
        'standard_versions_freeze',
        'standard_rules_freeze',
        'standard_version_snapshots_append_only',
        'standard_rules_schema_version_matches'
      )
    `;
    expect(rows).toHaveLength(4);
  });

  it('allows at most one published version per standard', async () => {
    const rows = await admin.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'standard_versions_one_published_per_standard'
    `;
    expect(rows).toHaveLength(1);
    // A partial index, not a trigger: it is checked by the same mechanism as
    // every other uniqueness constraint.
    expect(rows[0]!.indexdef).toContain("WHERE (status = 'PUBLISHED'");
  });

  it('constrains the content hash format in the database', async () => {
    const rows = await admin.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conname IN (
        'standard_versions_content_hash_format',
        'standard_version_snapshots_content_hash_format',
        'standard_rules_blocking_requires_deterministic_v1',
        'standard_rules_schema_version_supported',
        'standard_versions_schema_version_supported',
        'standard_versions_publication_fields'
      )
    `;
    expect(rows).toHaveLength(6);
  });
});
