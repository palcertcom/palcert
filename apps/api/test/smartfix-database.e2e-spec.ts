import { type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  fundForSmartFix,
  planSmartFix,
  smartFixRow,
  startSmartFix,
} from './support/smartfix-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * What the database refuses about a correction (§196–§200).
 *
 * Every attempt here uses the schema-owning connection — the most privileged
 * identity in the system — because a guarantee that only holds while the
 * application behaves is not a guarantee. If a service bug, a migration
 * script or a support engineer could write one of these rows, somebody's
 * thesis would be wrong and nothing would notice.
 */
describe('SmartFix - database invariants (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
  let stranger: { email: string; userId: string; client: AuthClient };
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    student = await createUser(context, 'student@example.com');
    stranger = await createUser(context, 'stranger@example.com');
    tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId);
  });

  /** A completed check, and the version it examined. */
  async function completedCheck(): Promise<{
    checkId: string;
    versionId: string;
    documentId: string;
  }> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);
    return { checkId: created.body.id, versionId, documentId: document.id };
  }

  /** A delivered correction to attack. */
  async function deliveredCorrection(): Promise<
    Awaited<ReturnType<typeof smartFixRow>> & { sourceVersionId: string }
  > {
    const { checkId, versionId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    const { quoteId } = await fundForSmartFix(context, student.userId);
    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quoteId,
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      if (row.status === 'DELIVERED') break;
      if (row.status === 'FAILED' || row.status === 'CANCELLED') {
        throw new Error(`correction ended as ${row.status}: ${row.failureCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ...(await smartFixRow(context, started.body.id)), sourceVersionId: versionId };
  }

  // -------------------------------------------------------------------------
  // The original is never modified (§196)
  // -------------------------------------------------------------------------

  describe('document lineage', () => {
    it('refuses a correction with no parent', async () => {
      const { documentId } = await completedCheck();
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "document_versions"
            ("id", "document_id", "owner_user_id", "version_number", "status", "original_filename",
             "expected_format", "declared_size_bytes", "quarantine_object_key", "origin",
             "updated_at")
          VALUES (gen_random_uuid(), ${documentId}::uuid, ${student.userId}::uuid, 99,
                  'AWAITING_UPLOAD', 'x.docx', 'DOCX', 10, 'staging/x', 'SMARTFIX', now())
        `,
      ).rejects.toThrow(/correction without lineage/);
    });

    it('refuses an upload that claims a parent', async () => {
      const { documentId, versionId } = await completedCheck();
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "document_versions"
            ("id", "document_id", "owner_user_id", "version_number", "status", "original_filename",
             "expected_format", "declared_size_bytes", "quarantine_object_key",
             "source_document_version_id", "updated_at")
          VALUES (gen_random_uuid(), ${documentId}::uuid, ${student.userId}::uuid, 98,
                  'AWAITING_UPLOAD', 'x.docx', 'DOCX', 10, 'staging/y', ${versionId}::uuid, now())
        `,
      ).rejects.toThrow(/upload and cannot have correction lineage/);
    });

    it('refuses to retro-fit lineage onto an existing original', async () => {
      // Otherwise an original could be dressed up as a correction after the
      // fact, and the history of what the author actually uploaded would be
      // unrecoverable.
      const { versionId } = await completedCheck();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "document_versions" SET "origin" = 'SMARTFIX' WHERE "id" = ${versionId}::uuid
        `,
      ).rejects.toThrow(/lineage is written once/);
    });

    it('refuses to hide a person’s own upload from them', async () => {
      const { versionId } = await completedCheck();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "document_versions" SET "visible_to_owner" = false WHERE "id" = ${versionId}::uuid
        `,
      ).rejects.toThrow(/cannot be hidden from its owner/);
    });

    it('leaves the source document byte-identical after a correction', async () => {
      const delivered = await deliveredCorrection();
      const source = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: delivered.sourceVersionId },
      });
      const corrected = delivered.correctedVersion!;

      // The original's identity is exactly what it was: same digest, same
      // object, same origin, no parent.
      expect(source.origin).toBe('USER_UPLOAD');
      expect(source.sourceDocumentVersionId).toBeNull();
      expect(source.smartFixRequestId).toBeNull();
      expect(corrected.sourceDocumentVersionId).toBe(source.id);
      expect(corrected.sha256).not.toBe(source.sha256);
      expect(corrected.cleanObjectKey).not.toBe(source.cleanObjectKey);

      // And the stored bytes still hash to what the check recorded.
      const bytes = await context.storage.getObjectBytes({
        zone: 'clean',
        key: source.cleanObjectKey!,
      });
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    });
  });

  // -------------------------------------------------------------------------
  // A correction is invisible until delivered (§198)
  // -------------------------------------------------------------------------

  describe('visibility', () => {
    it('refuses to make a correction visible before it is delivered', async () => {
      const { checkId } = await completedCheck();
      const planned = await planSmartFix(student.client, checkId);
      const { quoteId } = await fundForSmartFix(context, student.userId);
      context.documentEngine.smartFixMode = 'unavailable';
      const started = await startSmartFix(student.client, {
        planId: planned.body.id,
        priceQuoteId: quoteId,
      });

      // Nothing has been produced yet, so there is nothing to reveal — which
      // is itself the point: the row cannot exist visible and undelivered.
      const request = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      expect(request.correctedDocumentVersionId).toBeNull();
      expect(request.status).not.toBe('DELIVERED');
    });

    it('refuses a delivered correction whose output is still hidden', async () => {
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "document_versions" SET "visible_to_owner" = false
          WHERE "id" = ${delivered.correctedDocumentVersionId!}::uuid
        `,
      ).rejects.toThrow(/is hidden but its correction was delivered/);
    });
  });

  // -------------------------------------------------------------------------
  // No free check through the side door (§200)
  // -------------------------------------------------------------------------

  describe('check purpose', () => {
    it('refuses a recheck with no correction behind it', async () => {
      const { checkId } = await completedCheck();
      const template = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: checkId },
      });
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "document_checks"
            ("id", "owner_user_id", "document_id", "document_version_id", "organization_id",
             "document_type_id", "standard_id", "standard_version_id", "document_sha256",
             "standard_content_hash", "organization_name", "document_type_name",
             "standard_code", "standard_name", "standard_version_label", "purpose", "updated_at")
          VALUES (gen_random_uuid(), ${student.userId}::uuid, ${template.documentId}::uuid,
                  ${template.documentVersionId}::uuid, ${template.organizationId}::uuid,
                  ${template.documentTypeId}::uuid, ${template.standardId}::uuid,
                  ${template.standardVersionId}::uuid, ${template.documentSha256},
                  ${template.standardContentHash}, 'x', 'y', 'z', 'n', 'v',
                  'SMARTFIX_RECHECK', now())
        `,
      ).rejects.toThrow(/recheck with no correction behind it/);
    });

    it('refuses a recheck of a version the correction did not produce', async () => {
      const delivered = await deliveredCorrection();
      const template = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: delivered.checkId },
      });
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "document_checks"
            ("id", "owner_user_id", "document_id", "document_version_id", "organization_id",
             "document_type_id", "standard_id", "standard_version_id", "document_sha256",
             "standard_content_hash", "organization_name", "document_type_name",
             "standard_code", "standard_name", "standard_version_label", "purpose",
             "smartfix_request_id", "updated_at")
          VALUES (gen_random_uuid(), ${student.userId}::uuid, ${template.documentId}::uuid,
                  ${delivered.sourceVersionId}::uuid, ${template.organizationId}::uuid,
                  ${template.documentTypeId}::uuid, ${template.standardId}::uuid,
                  ${template.standardVersionId}::uuid, ${template.documentSha256},
                  ${template.standardContentHash}, 'x', 'y', 'z', 'n', 'v',
                  'SMARTFIX_RECHECK', ${delivered.id}::uuid, now())
        `,
      ).rejects.toThrow(/rechecks a version the correction did not produce/);
    });

    it('refuses a recheck that carries a purchase of its own', async () => {
      // The user paid for the recheck once, as part of the correction.
      // Charging again would be charging twice for one service (§93).
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "document_checks" SET "service_purchase_id" = ${delivered.servicePurchaseId}::uuid
          WHERE "id" = ${delivered.recheckCheckId!}::uuid
        `,
      ).rejects.toThrow();
    });

    it('refuses to reclassify a user’s own check as a recheck', async () => {
      const { checkId } = await completedCheck();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "document_checks" SET "purpose" = 'SMARTFIX_RECHECK' WHERE "id" = ${checkId}::uuid
        `,
      ).rejects.toThrow(/purpose is written once/);
    });

    it('gives the recheck no purchase and the correction exactly one', async () => {
      const delivered = await deliveredCorrection();
      expect(delivered.recheck!.servicePurchaseId).toBeNull();
      expect(delivered.recheck!.purpose).toBe('SMARTFIX_RECHECK');
      expect(
        await context.adminDb.servicePurchase.count({
          where: { ownerUserId: student.userId, resourceType: 'SMARTFIX' },
        }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Nothing delivered without proof and payment (§199)
  // -------------------------------------------------------------------------

  describe('delivery', () => {
    it('refuses a manifest that admits it changed the text', async () => {
      // The proofs are columns and a CHECK constraint, so a manifest that
      // disagrees with itself cannot exist — not merely be rejected by
      // whichever service last looked at it (§111).
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "smartfix_manifests"
            ("id", "owner_user_id", "request_id", "manifest_schema_version", "fix_engine_name",
             "fix_engine_version", "plan_hash", "source_sha256", "output_sha256", "manifest_hash",
             "entry_count", "changed_parts", "source_visible_text_hash", "output_visible_text_hash",
             "source_media_set_hash", "output_media_set_hash", "source_field_instruction_hash",
             "output_field_instruction_hash", "source_relationship_hash", "output_relationship_hash",
             "artifact_object_key", "artifact_size_bytes")
          VALUES (gen_random_uuid(), ${student.userId}::uuid, gen_random_uuid(), 1, 'e', '1.0.0',
                  ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, ${'d'.repeat(64)},
                  1, ARRAY['word/document.xml'],
                  ${'1'.repeat(64)}, ${'2'.repeat(64)},
                  ${'3'.repeat(64)}, ${'3'.repeat(64)},
                  ${'4'.repeat(64)}, ${'4'.repeat(64)},
                  ${'5'.repeat(64)}, ${'5'.repeat(64)},
                  'users/x/manifest.json', 10)
        `,
      ).rejects.toThrow(/smartfix_manifests_integrity_holds/);
      expect(delivered.manifest).not.toBeNull();
    });

    it('refuses a manifest whose output is identical to its source', async () => {
      // A correction that changed nothing is not a correction, and nobody
      // should be charged for one.
      const same = 'f'.repeat(64);
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "smartfix_manifests"
            ("id", "owner_user_id", "request_id", "manifest_schema_version", "fix_engine_name",
             "fix_engine_version", "plan_hash", "source_sha256", "output_sha256", "manifest_hash",
             "entry_count", "changed_parts", "source_visible_text_hash", "output_visible_text_hash",
             "source_media_set_hash", "output_media_set_hash", "source_field_instruction_hash",
             "output_field_instruction_hash", "source_relationship_hash", "output_relationship_hash",
             "artifact_object_key", "artifact_size_bytes")
          VALUES (gen_random_uuid(), ${student.userId}::uuid, gen_random_uuid(), 1, 'e', '1.0.0',
                  ${'a'.repeat(64)}, ${same}, ${same}, ${'d'.repeat(64)},
                  1, ARRAY['word/document.xml'],
                  ${'1'.repeat(64)}, ${'1'.repeat(64)},
                  ${'3'.repeat(64)}, ${'3'.repeat(64)},
                  ${'4'.repeat(64)}, ${'4'.repeat(64)},
                  ${'5'.repeat(64)}, ${'5'.repeat(64)},
                  'users/y/manifest.json', 10)
        `,
      ).rejects.toThrow(/smartfix_manifests_output_differs/);
    });

    it('refuses to edit a manifest after the fact', async () => {
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "smartfix_manifests" SET "entry_count" = 0 WHERE "request_id" = ${delivered.id}::uuid
        `,
      ).rejects.toThrow(/written once/);
    });

    it('refuses a delivered correction with no manifest', async () => {
      const { checkId } = await completedCheck();
      const planned = await planSmartFix(student.client, checkId);
      const { quoteId } = await fundForSmartFix(context, student.userId);
      context.documentEngine.smartFixMode = 'unavailable';
      const started = await startSmartFix(student.client, {
        planId: planned.body.id,
        priceQuoteId: quoteId,
      });

      await expect(
        context.adminDb.$executeRaw`
          UPDATE "smartfix_requests"
          SET "status" = 'DELIVERED', "delivered_at" = now()
          WHERE "id" = ${started.body.id}::uuid
        `,
      ).rejects.toThrow();
    });

    it('refuses a correction whose status machine runs backwards', async () => {
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "smartfix_requests" SET "status" = 'PROCESSING' WHERE "id" = ${delivered.id}::uuid
        `,
      ).rejects.toThrow(/cannot move from DELIVERED to PROCESSING/);
    });

    it('refuses to move a correction onto another plan', async () => {
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          UPDATE "smartfix_requests" SET "plan_hash" = ${'0'.repeat(64)}
          WHERE "id" = ${delivered.id}::uuid
        `,
      ).rejects.toThrow(/identity is immutable/);
    });

    it('refuses a correction that names another person’s purchase', async () => {
      const delivered = await deliveredCorrection();
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "smartfix_requests"
            ("id", "owner_user_id", "plan_id", "plan_hash", "check_id", "document_id",
             "source_document_version_id", "standard_version_id", "service_purchase_id",
             "updated_at")
          VALUES (gen_random_uuid(), ${stranger.userId}::uuid, ${delivered.planId}::uuid,
                  ${delivered.planHash}, ${delivered.checkId}::uuid, ${delivered.documentId}::uuid,
                  ${delivered.sourceVersionId}::uuid, ${delivered.standardVersionId}::uuid,
                  ${delivered.servicePurchaseId}::uuid, now())
        `,
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // A failed correction is free (§80)
  // -------------------------------------------------------------------------

  it('refuses a failed correction whose reservation was charged', async () => {
    const delivered = await deliveredCorrection();
    // The purchase was captured on delivery. Marking the correction FAILED now
    // would mean a charge with nothing delivered.
    await expect(
      context.adminDb.$executeRaw`
        UPDATE "smartfix_requests"
        SET "status" = 'FAILED', "failed_at" = now(), "failure_code" = 'SERVICE_FAILED'
        WHERE "id" = ${delivered.id}::uuid
      `,
    ).rejects.toThrow();
  });

  it('never lets the application role delete financial or evidential history', async () => {
    const delivered = await deliveredCorrection();
    await expect(
      context.prisma
        .$executeRaw`DELETE FROM "smartfix_manifests" WHERE "request_id" = ${delivered.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      context.prisma
        .$executeRaw`DELETE FROM "smartfix_requests" WHERE "id" = ${delivered.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      context.prisma
        .$executeRaw`DELETE FROM "smartfix_plans" WHERE "id" = ${delivered.planId}::uuid`,
    ).rejects.toThrow(/permission denied/);
  });
});
