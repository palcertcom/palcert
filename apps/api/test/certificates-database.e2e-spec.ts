import { type AuthClient } from './support/auth-client';
import {
  readCertificate,
  revokeCertificate,
  waitForCertificate,
} from './support/certificates-client';
import { type PublishedStandard } from './support/checks-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import { CertificateIssueJobHandler } from '../src/worker/certificate-issue-job.handler';
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

/**
 * What the database refuses about a certificate (§122–§128, §152).
 *
 * Every attempt below uses the schema-owning connection — the most privileged
 * identity in the system — because a guarantee that only holds while the
 * application behaves is not a guarantee. A certificate is the one artifact in
 * PalCert that a stranger is invited to trust, so the interesting question is
 * not "does the service refuse this" but "could anything write it at all".
 *
 * `FORCE ROW LEVEL SECURITY` is what makes these tests meaningful: without it
 * the table owner would bypass every policy and the assertions would be
 * theatre.
 */
describe('Certificates — database invariants (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;
  let certificateId: string;
  let revisionId: string;
  let codeHash: string;

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
    standard = await publishStandardFor(context, university);

    const check = await completedCheck(context, author, standard);
    const submitted = await submitAndPrepare(context, author.client, check.checkId);
    revisionId = submitted.revisionId;
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    const settled = await waitForCertificate(context, revisionId);
    certificateId = settled.id;
    codeHash = (
      await context.adminDb.complianceCertificate.findUniqueOrThrow({
        where: { id: certificateId },
      })
    ).verificationCodeHash;
  });

  /** Run one statement as the schema owner and report whether it was refused. */
  async function refused(sql: string, ...params: unknown[]): Promise<string | null> {
    try {
      await context.adminDb.$executeRawUnsafe(sql, ...params);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The same, with one party's context established on the app connection. */
  async function asParty(
    party: { userId?: string; organizationId?: string },
    sql: string,
    ...params: unknown[]
  ): Promise<{ error: string | null; affected: number }> {
    try {
      const affected = await context.prisma.$transaction(async (tx) => {
        if (party.userId !== undefined) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('palcert.current_user_id', $1, true)`,
            party.userId,
          );
        }
        if (party.organizationId !== undefined) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('palcert.current_organization_id', $1, true)`,
            party.organizationId,
          );
        }
        return tx.$executeRawUnsafe(sql, ...params);
      });
      return { error: null, affected };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        affected: 0,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Neither party may write one (§122, §123, §190–§192)
  // -------------------------------------------------------------------------

  it('refuses a certificate inserted by its own subject', async () => {
    const attempt = await asParty(
      { userId: author.userId },
      `INSERT INTO "compliance_certificates"
         ("id", "owner_user_id", "submission_id", "submission_revision_id", "organization_id",
          "verification_code_hash", "issuance_status")
       SELECT gen_random_uuid(), "owner_user_id", "submission_id", "submission_revision_id",
              "organization_id", repeat('a', 64), 'PENDING'
         FROM "compliance_certificates" WHERE "id" = $1::uuid`,
      certificateId,
    );
    expect(attempt.error).not.toBeNull();
    expect(await context.adminDb.complianceCertificate.count()).toBe(1);
  });

  it('refuses a certificate inserted by the approving organization', async () => {
    // §192: approving makes a submission eligible. It does not hand the
    // institution the ability to mint the certificate itself.
    const attempt = await asParty(
      { userId: university.owner.userId, organizationId: university.organizationId },
      `INSERT INTO "compliance_certificates"
         ("id", "owner_user_id", "submission_id", "submission_revision_id", "organization_id",
          "verification_code_hash", "issuance_status")
       SELECT gen_random_uuid(), "owner_user_id", "submission_id", "submission_revision_id",
              "organization_id", repeat('b', 64), 'PENDING'
         FROM "compliance_certificates" WHERE "id" = $1::uuid`,
      certificateId,
    );
    expect(attempt.error).not.toBeNull();
    expect(await context.adminDb.complianceCertificate.count()).toBe(1);
  });

  it('refuses a certificate inserted by the schema owner itself', async () => {
    // The strongest form: the system-writer predicate needs a role switch that
    // only a SECURITY DEFINER function owned by a privileged role can reach,
    // so even the owning connection cannot forge one.
    expect(
      await refused(
        `INSERT INTO "compliance_certificates"
           ("id", "owner_user_id", "submission_id", "submission_revision_id", "organization_id",
            "verification_code_hash", "issuance_status")
         SELECT gen_random_uuid(), "owner_user_id", "submission_id", "submission_revision_id",
                "organization_id", repeat('c', 64), 'PENDING'
           FROM "compliance_certificates" WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).not.toBeNull();
  });

  it('refuses an event inserted by either party', async () => {
    // §126: the lifecycle is written by the system, including the revocation
    // event — which the narrow function writes *as* the reviewer rather than
    // letting the reviewer write it.
    for (const party of [
      { userId: author.userId },
      { userId: university.owner.userId, organizationId: university.organizationId },
    ]) {
      const attempt = await asParty(
        party,
        `INSERT INTO "certificate_events"
           ("id", "certificate_id", "owner_user_id", "organization_id", "event_type", "event_source")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'REVOKED', 'ORGANIZATION')`,
        certificateId,
        author.userId,
        university.organizationId,
      );
      expect(attempt.error).not.toBeNull();
    }
    expect(await context.adminDb.certificateEvent.count()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Nothing is deleted, and history never changes (§59, §95, §126)
  // -------------------------------------------------------------------------

  it('does not grant the application role the ability to delete either table', async () => {
    for (const table of ['compliance_certificates', 'certificate_events']) {
      const granted = await context.adminDb.$queryRawUnsafe<{ has: boolean }[]>(
        `SELECT has_table_privilege('palcert_app', $1, 'DELETE') AS has`,
        table,
      );
      expect([table, granted[0]?.has]).toEqual([table, false]);
    }
  });

  it('refuses to edit or delete a lifecycle event, even as the schema owner', async () => {
    expect(
      await refused(
        `UPDATE "certificate_events" SET "event_type" = 'REVOKED' WHERE "certificate_id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('immutable');
    expect(
      await refused(
        `DELETE FROM "certificate_events" WHERE "certificate_id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('immutable');
  });

  // -------------------------------------------------------------------------
  // What an issued certificate may never become (§34, §94, §187, §188)
  // -------------------------------------------------------------------------

  it('refuses to re-point a certificate at a different revision or owner', async () => {
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "submission_revision_id" = gen_random_uuid()
         WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('immutable');
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "owner_user_id" = gen_random_uuid()
         WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('immutable');
  });

  it('refuses to rewrite the claim of an issued certificate', async () => {
    // §34: a later template, a renamed organization or an edited standard
    // label must never change what an old certificate says.
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "claim_hash" = repeat('d', 64) WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('write-once');
  });

  it('refuses to un-revoke, and refuses to un-issue', async () => {
    // §67: there is no way back, at any level of privilege.
    const revoked = await revokeCertificate(
      university.owner.client,
      university.organizationId,
      certificateId,
      { reasonCode: 'ISSUED_IN_ERROR' },
    );
    expect(revoked.status).toBe(200);
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "issuance_status" = 'ISSUED' WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('cannot move from');
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "issuance_status" = 'PENDING' WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('cannot move from');
  });

  it('refuses to re-key an issued certificate’s verification digest', async () => {
    // The digest is what resolves an already-printed QR. Changing it on an
    // issued certificate would silently stop that QR working, so it is fixed
    // for ever once anything has been issued against it.
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "verification_code_hash" = repeat('e', 64)
         WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('verification code is immutable');
  });

  it('refuses to put staging material back into an issued certificate', async () => {
    // Issuance erased it. Re-sealing a code into the row would put back
    // exactly the capability the erasure removed.
    expect(
      await refused(
        `UPDATE "compliance_certificates" SET "verification_code_ciphertext" = 'anything'
         WHERE "id" = $1::uuid`,
        certificateId,
      ),
    ).toContain('write-once');
  });

  // -------------------------------------------------------------------------
  // Reading it (§52, §53, §127)
  // -------------------------------------------------------------------------

  it('shows the application role nothing without a context', async () => {
    // §127: `palcert_app` holds SELECT, and RLS is what decides. A connection
    // with no user and no organization established sees no certificates at
    // all — which is what makes a leaked connection string not a directory.
    const rows = await context.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT "id" FROM "compliance_certificates"`,
    );
    expect(rows).toEqual([]);
    const events = await context.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT "id" FROM "certificate_events"`,
    );
    expect(events).toEqual([]);
  });

  it('shows each party its own row, and a stranger nothing', async () => {
    const stranger = await createUser(context, 'stranger@example.com');
    const seen = async (party: { userId?: string; organizationId?: string }) => {
      const rows = await context.prisma.$transaction(async (tx) => {
        if (party.userId !== undefined) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('palcert.current_user_id', $1, true)`,
            party.userId,
          );
        }
        if (party.organizationId !== undefined) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('palcert.current_organization_id', $1, true)`,
            party.organizationId,
          );
        }
        return tx.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "compliance_certificates"`);
      });
      return rows.map((row) => row.id);
    };

    expect(await seen({ userId: author.userId })).toEqual([certificateId]);
    expect(
      await seen({ userId: university.owner.userId, organizationId: university.organizationId }),
    ).toEqual([certificateId]);
    expect(await seen({ userId: stranger.userId })).toEqual([]);
  });

  it('classifies both tables, so the coverage gate keeps watching them', async () => {
    const rows = await context.adminDb.$queryRawUnsafe<{ table_name: string; kind: string }[]>(
      `SELECT "table_name", "classification" AS kind FROM "table_isolation_classification"
        WHERE "table_name" IN ('compliance_certificates', 'certificate_events')
        ORDER BY "table_name"`,
    );
    expect(rows).toEqual([
      { table_name: 'certificate_events', kind: 'DUAL_PARTY_SCOPED' },
      { table_name: 'compliance_certificates', kind: 'DUAL_PARTY_SCOPED' },
    ]);
  });

  // -------------------------------------------------------------------------
  // The public projection (§57, §58, §152)
  // -------------------------------------------------------------------------

  it('answers only for an issued certificate, and only by code hash', async () => {
    const found = await context.prisma.$queryRawUnsafe<{ issuance_status: string }[]>(
      `SELECT * FROM app_public_certificate($1)`,
      codeHash,
    );
    expect(found).toHaveLength(1);

    // An unknown hash is empty rather than an error: a verifier probing must
    // not be able to tell a wrong code from a wrong shape.
    expect(
      await context.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT * FROM app_public_certificate($1)`,
        'f'.repeat(64),
      ),
    ).toEqual([]);
  });

  it('returns a fixed column list that carries no identity', async () => {
    // §58: the projection is the public surface. Widening it is how a private
    // field reaches the internet, so the shape is asserted rather than read.
    const columns = await context.adminDb.$queryRawUnsafe<{ name: string }[]>(
      `SELECT unnest(proargnames) AS name FROM pg_proc WHERE proname = 'app_public_certificate'`,
    );
    const names = columns.map((column) => column.name).filter((name) => name !== undefined);
    for (const forbidden of [
      'owner_user_id',
      'submission_id',
      'submission_revision_id',
      'organization_id',
      'verification_code_hash',
      'claim_object_key',
      'certificate_object_key',
      'certificate_object_version_id',
      'revocation_comment',
      'failure_code',
    ]) {
      expect([forbidden, names.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('is read-only, pinned and free of dynamic SQL', async () => {
    // §58: a SECURITY DEFINER function is a hole punched through RLS, so this
    // one is deliberately boring — plain SQL, immutable search_path, no
    // EXECUTE, and volatility the database itself will not let mutate.
    const [fn] = await context.adminDb.$queryRawUnsafe<
      { lang: string; volatile: string; config: string[] | null; body: string }[]
    >(
      `SELECT l.lanname AS lang, p.provolatile AS volatile, p.proconfig AS config, p.prosrc AS body
         FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.proname = 'app_public_certificate'`,
    );
    expect(fn?.lang).toBe('sql');
    // 's' is STABLE: it cannot write, and the database enforces that.
    expect(fn?.volatile).toBe('s');
    expect(fn?.config).toEqual(['search_path=public']);
    expect(fn?.body ?? '').not.toMatch(/EXECUTE|format\(/i);
    for (const statement of ['INSERT', 'UPDATE', 'DELETE']) {
      expect([statement, (fn?.body ?? '').toUpperCase().includes(statement)]).toEqual([
        statement,
        false,
      ]);
    }
  });

  it('keeps no plaintext or reversible verification capability in the row', async () => {
    // The finding this correction exists for. `certificate_number` was `PC-`
    // plus the very symbols of the code, so one SELECT over this table handed
    // the reader a working verification for every certificate ever issued.
    //
    // Asserted by sentinel: take the real code out of the issued claim, then
    // search every visible column of every certificate row for it, in every
    // form it could plausibly be stored in.
    const view = await readCertificate(author.client, certificateId);
    const code = view.body.verificationCode as string;
    const number = view.body.certificateNumber as string;
    expect(code).toHaveLength(32);
    expect(number).toMatch(/^PC-[0-9A-HJKMNP-TV-Z]{8}(-[0-9A-HJKMNP-TV-Z]{8}){3}$/);

    const columns = await context.adminDb.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT "column_name" FROM information_schema.columns
        WHERE "table_name" = 'compliance_certificates'`,
    );
    const names = columns.map((column) => column.column_name);
    expect(names).toContain('verification_code_hash');
    expect(names).not.toContain('verification_code');
    expect(names).not.toContain('certificate_number');

    // Every column of every row, serialized, searched for the capability.
    const rows = await context.adminDb.$queryRawUnsafe<{ row: string }[]>(
      `SELECT to_jsonb(c)::text AS row FROM "compliance_certificates" c`,
    );
    expect(rows).toHaveLength(1);
    const serialized = rows[0]?.row ?? '';
    for (const form of [
      code,
      number,
      code.toLowerCase(),
      number.toLowerCase(),
      code.slice(0, 16),
      Buffer.from(code, 'utf8').toString('base64'),
    ]) {
      expect([form, serialized.includes(form)]).toEqual([form, false]);
    }

    // The staging column is erased at issuance, so there is not even sealed
    // material left to attack.
    expect(serialized).toContain('verification_code_ciphertext');
    expect(
      (
        await context.adminDb.complianceCertificate.findUniqueOrThrow({
          where: { id: certificateId },
        })
      ).verificationCodeCiphertext,
    ).toBeNull();
  });

  it('gives neither party a way to read a verification code out of the row', async () => {
    // Each party legitimately sees its own certificate row. Neither may get a
    // capability out of it — which is the whole difference between a shared
    // read and a shared secret.
    const view = await readCertificate(author.client, certificateId);
    const code = view.body.verificationCode as string;
    const number = view.body.certificateNumber as string;

    const rowAs = async (party: { userId?: string; organizationId?: string }) => {
      const rows = await context.prisma.$transaction(async (tx) => {
        if (party.userId !== undefined) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('palcert.current_user_id', $1, true)`,
            party.userId,
          );
        }
        if (party.organizationId !== undefined) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('palcert.current_organization_id', $1, true)`,
            party.organizationId,
          );
        }
        return tx.$queryRawUnsafe<{ row: string }[]>(
          `SELECT to_jsonb(c)::text AS row FROM "compliance_certificates" c`,
        );
      });
      return rows.map((entry) => entry.row).join('');
    };

    for (const [label, party] of [
      ['submitter', { userId: author.userId }],
      [
        'organization',
        { userId: university.owner.userId, organizationId: university.organizationId },
      ],
      ['anonymous', {}],
    ] as const) {
      const serialized = await rowAs(party);
      for (const form of [code, number, code.toLowerCase()]) {
        expect([label, form, serialized.includes(form)]).toEqual([label, form, false]);
      }
    }

    // The anonymous context sees nothing at all, which is the strongest form
    // of the same statement.
    expect(await rowAs({})).toBe('');
  });

  it('keeps sealed staging material unreadable while it exists', async () => {
    // Before issuance there is a sealed copy, because the worker needs one.
    // It must be openable only with the application's key — not derivable
    // from anything the database holds.
    const second = await createUser(context, 'second@example.com');
    const check = await completedCheck(context, second, standard);
    const submitted = await submitAndPrepare(context, second.client, check.checkId);

    // Silence issuance so the row is observed mid-flight, with its staging
    // material still present.
    const handler = context.workerApp.get(CertificateIssueJobHandler);
    const held = jest.spyOn(handler, 'handle').mockResolvedValue(undefined);
    await decide(university.owner.client, university.organizationId, submitted.revisionId, {
      toStatus: 'APPROVED',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pending = await context.adminDb.complianceCertificate.findFirstOrThrow({
      where: { submissionRevisionId: submitted.revisionId },
    });
    held.mockRestore();

    expect(pending.issuanceStatus).toBe('PENDING');
    const sealed = pending.verificationCodeCiphertext;
    expect(sealed).not.toBeNull();

    // It is an authenticated-encryption envelope, and nothing in it can be
    // read as a code: no 32-symbol Crockford run, no PC- number.
    const envelope = JSON.parse(sealed!) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['authTag', 'ciphertext', 'iv', 'v']);
    expect(sealed).not.toMatch(/PC-[0-9A-HJKMNP-TV-Z]{8}/);
    expect(sealed).not.toMatch(/[0-9A-HJKMNP-TV-Z]{32}/);
    // And the key is not in the database: nothing in the row or its function
    // definitions mentions it.
    const functions = await context.adminDb.$queryRawUnsafe<{ src: string }[]>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname LIKE 'app_certificate%'`,
    );
    for (const fn of functions) {
      expect(fn.src).not.toMatch(/decrypt|pgp_|aes/i);
    }
  });
});
