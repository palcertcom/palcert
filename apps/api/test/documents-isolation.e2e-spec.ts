import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import type { AuthClient } from './support/auth-client';
import {
  DOCUMENTS,
  createDocument,
  createVersion,
  uploadAndProcess,
} from './support/documents-client';
import { minimalPdf } from './support/fixtures';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Cross-user isolation (§47) and the organization non-access rule (§48).
 *
 * Every attempt uses a real, valid identifier belonging to someone else.
 * The answer is always "not found": a 403 would confirm the identifier
 * exists, which is itself a leak (Phase 2's deliberate non-disclosure).
 */
describe('Documents — isolation (e2e)', () => {
  let context: TestContext;
  let alice: { userId: string; client: AuthClient };
  let bob: { userId: string; client: AuthClient };

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    alice = await createUser(context, 'alice@example.test');
    bob = await createUser(context, 'bob@example.test');
  });

  async function alicesReadyDocument(): Promise<{ documentId: string; versionId: string }> {
    const document = await createDocument(alice.client, "Alice's thesis");
    const { versionId } = await uploadAndProcess(alice.client, document.id, {
      name: 'thesis.pdf',
      bytes: minimalPdf(),
    });
    return { documentId: document.id, versionId };
  }

  // -------------------------------------------------------------------------
  describe('another user, at the HTTP layer', () => {
    it('cannot list, read, rename or delete her document', async () => {
      const { documentId } = await alicesReadyDocument();
      await createDocument(bob.client, "Bob's own");

      const list = await bob.client.get(DOCUMENTS);
      expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(documentId);

      expect((await bob.client.get(`${DOCUMENTS}/${documentId}`)).status).toBe(404);
      expect(
        (await bob.client.patch(`${DOCUMENTS}/${documentId}`, { displayName: 'pwned' })).status,
      ).toBe(404);
      expect((await bob.client.delete(`${DOCUMENTS}/${documentId}`)).status).toBe(404);

      const intact = await alice.client.get(`${DOCUMENTS}/${documentId}`);
      expect(intact.body.displayName).toBe("Alice's thesis");
    });

    it('cannot read her versions, create one under her document, finalize, cancel, retry or download', async () => {
      const { documentId, versionId } = await alicesReadyDocument();
      const base = `${DOCUMENTS}/${documentId}/versions`;

      expect((await bob.client.get(base)).status).toBe(404);
      expect((await bob.client.get(`${base}/${versionId}`)).status).toBe(404);
      expect(
        (await bob.client.post(base, { originalFilename: 'x.pdf', sizeBytes: 10 })).status,
      ).toBe(404);
      expect((await bob.client.post(`${base}/${versionId}/finalize`)).status).toBe(404);
      expect((await bob.client.post(`${base}/${versionId}/cancel`)).status).toBe(404);
      expect((await bob.client.post(`${base}/${versionId}/retry`)).status).toBe(404);
      expect((await bob.client.post(`${base}/${versionId}/upload-authorizations`)).status).toBe(
        404,
      );
      expect((await bob.client.post(`${base}/${versionId}/download-authorization`)).status).toBe(
        404,
      );

      expect(await context.adminDb.documentVersion.count({ where: { documentId } })).toBe(1);
    });

    it('cannot finalize or hijack her in-flight upload', async () => {
      const document = await createDocument(alice.client);
      const created = await createVersion(alice.client, document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });

      const response = await bob.client.post(
        `${DOCUMENTS}/${document.id}/versions/${created.versionId}/finalize`,
      );
      expect(response.status).toBe(404);
      const row = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: created.versionId },
      });
      expect(row.status).toBe('AWAITING_UPLOAD');
    });

    it('reveals no metadata through error bodies', async () => {
      const { documentId, versionId } = await alicesReadyDocument();
      const response = await bob.client.get(`${DOCUMENTS}/${documentId}/versions/${versionId}`);
      expect(JSON.stringify(response.body)).not.toMatch(/thesis|alice|READY|sha256/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('organizations have no document access (§48)', () => {
    let tenant: TenantFixture;

    beforeEach(async () => {
      tenant = await createTenant(context, 'Islamic University', 'owner@iug.test');
    });

    it("the organization owner cannot read a member's private document", async () => {
      await grantOrganizationRoleTo(context, tenant, alice, 'ORGANIZATION_REVIEWER');
      const { documentId, versionId } = await alicesReadyDocument();

      expect((await tenant.owner.client.get(`${DOCUMENTS}/${documentId}`)).status).toBe(404);
      expect(
        (await tenant.owner.client.get(`${DOCUMENTS}/${documentId}/versions/${versionId}`)).status,
      ).toBe(404);
      expect(
        (
          await tenant.owner.client.post(
            `${DOCUMENTS}/${documentId}/versions/${versionId}/download-authorization`,
          )
        ).status,
      ).toBe(404);
      expect((await tenant.owner.client.get(DOCUMENTS)).body.items).toEqual([]);
    });

    it("an organization admin cannot read a member's private document", async () => {
      const admin = await createUser(context, 'admin@iug.test');
      await grantOrganizationRoleTo(context, tenant, admin, 'ORGANIZATION_ADMIN');
      await grantOrganizationRoleTo(context, tenant, alice, 'ORGANIZATION_REVIEWER');
      const { documentId } = await alicesReadyDocument();

      expect((await admin.client.get(`${DOCUMENTS}/${documentId}`)).status).toBe(404);
      expect((await admin.client.get(DOCUMENTS)).body.items).toEqual([]);
    });

    it('no route accepts an organization to widen the scope', async () => {
      const { documentId } = await alicesReadyDocument();
      const response = await tenant.owner.client.get(
        `${DOCUMENTS}/${documentId}?organizationId=${tenant.organizationId}`,
      );
      expect(response.status).not.toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('the database itself (raw RLS, as the request role)', () => {
    async function asUser<T>(
      userId: string | null,
      work: (tx: Parameters<Parameters<typeof context.prisma.$transaction>[0]>[0]) => Promise<T>,
    ): Promise<T> {
      return context.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', '', true)`;
        await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${userId ?? ''}, true)`;
        await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'off', true)`;
        return work(tx);
      });
    }

    it('returns no rows for another user, and no rows with no user at all', async () => {
      const { documentId, versionId } = await alicesReadyDocument();

      const asBob = await asUser(
        bob.userId,
        (tx) =>
          tx.$queryRaw<unknown[]>`SELECT "id" FROM "documents" WHERE "id" = ${documentId}::uuid`,
      );
      expect(asBob).toEqual([]);
      const versionsAsBob = await asUser(
        bob.userId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT "id" FROM "document_versions" WHERE "id" = ${versionId}::uuid`,
      );
      expect(versionsAsBob).toEqual([]);
      const sessionsAsBob = await asUser(
        bob.userId,
        (tx) => tx.$queryRaw<unknown[]>`SELECT "id" FROM "upload_sessions"`,
      );
      expect(sessionsAsBob).toEqual([]);

      const noContext = await asUser(
        null,
        (tx) => tx.$queryRaw<unknown[]>`SELECT "id" FROM "documents"`,
      );
      expect(noContext).toEqual([]);

      const asAlice = await asUser(
        alice.userId,
        (tx) =>
          tx.$queryRaw<unknown[]>`SELECT "id" FROM "documents" WHERE "id" = ${documentId}::uuid`,
      );
      expect(asAlice).toHaveLength(1);
    });

    it("refuses to write a row into another user's ownership", async () => {
      await expect(
        asUser(
          bob.userId,
          (tx) =>
            tx.$executeRaw`INSERT INTO "documents" ("id", "owner_user_id", "display_name", "status", "updated_at")
                         VALUES (gen_random_uuid(), ${alice.userId}::uuid, 'planted', 'ACTIVE', now())`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("cannot re-point a version at another user's document", async () => {
      const { versionId } = await alicesReadyDocument();
      const bobsDocument = await createDocument(bob.client);
      // Even the schema owner cannot: the composite key requires the owner to match.
      await expect(
        context.adminDb
          .$executeRaw`UPDATE "document_versions" SET "document_id" = ${bobsDocument.id}::uuid WHERE "id" = ${versionId}::uuid`,
      ).rejects.toThrow();
    });

    it('cannot rewrite the identity of a READY version, even as the schema owner', async () => {
      const { versionId } = await alicesReadyDocument();
      await expect(
        context.adminDb
          .$executeRaw`UPDATE "document_versions" SET "sha256" = ${'0'.repeat(64)} WHERE "id" = ${versionId}::uuid`,
      ).rejects.toThrow(/write-once/);
      await expect(
        context.adminDb
          .$executeRaw`UPDATE "document_versions" SET "clean_object_key" = 'users/x/other' WHERE "id" = ${versionId}::uuid`,
      ).rejects.toThrow(/write-once/);
      await expect(
        context.adminDb
          .$executeRaw`UPDATE "document_versions" SET "status" = 'UPLOADED' WHERE "id" = ${versionId}::uuid`,
      ).rejects.toThrow(/cannot move/);
    });

    it('cannot jump a version straight to READY', async () => {
      const document = await createDocument(alice.client);
      const created = await createVersion(alice.client, document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      await expect(
        context.adminDb
          .$executeRaw`UPDATE "document_versions" SET "status" = 'READY' WHERE "id" = ${created.versionId}::uuid`,
      ).rejects.toThrow();
    });
  });
});
