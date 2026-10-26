import {
  SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
  SUBMISSION_EVIDENCE_SCHEMA_VERSION,
  computeSubmissionEvidenceHash,
} from '@palcert/contracts';
import { type AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
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
 * What the database refuses about an official submission (§120–§128).
 *
 * Every attempt uses the schema-owning connection — the most privileged
 * identity in the system — because a guarantee that only holds while the
 * application behaves is not a guarantee. If a migration script, a support
 * engineer or a service bug could write one of these rows, an institution's
 * record of what it received would be forgeable.
 */
describe('Official submissions — database invariants (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;
  let submissionId: string;
  let revisionId: string;

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
    submissionId = submitted.submissionId;
    revisionId = submitted.revisionId;
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

  /**
   * The same, with the receiving organization's context established.
   *
   * Needed to reach the constraints *underneath* the write-authority trigger.
   * Without a context the trigger refuses a decision write first — correctly,
   * and even for the schema owner — which would leave the state machine, the
   * status vocabulary and the READY shape asserted only by construction.
   */
  async function refusedAsOrganization(sql: string, ...params: unknown[]): Promise<string | null> {
    try {
      await context.adminDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_organization_id', $1, true)`,
          university.organizationId,
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_user_id', $1, true)`,
          university.owner.userId,
        );
        await tx.$executeRawUnsafe(sql, ...params);
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  describe('the snapshot is write-once (§120, §40, §41)', () => {
    it('refuses a second write of the snapshot identity', async () => {
      expect(
        await refused(
          `UPDATE "submission_revisions" SET "document_snapshot_sha256" = repeat('c', 64)
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('write-once');
    });

    it('refuses a second write of the evidence hash', async () => {
      expect(
        await refused(
          `UPDATE "submission_revisions" SET "evidence_hash" = repeat('d', 64) WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('write-once');
    });

    it('refuses to change what the revision is bound to', async () => {
      // §11, §125: bound once at creation and never looked up again. A
      // revision that could be repointed would make "the exact check this
      // report describes" an opinion.
      expect(
        await refused(
          `UPDATE "submission_revisions" SET "source_check_id" = gen_random_uuid()
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('immutable');
      expect(
        await refused(
          `UPDATE "submission_revisions" SET "revision_number" = 7 WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('immutable');
    });

    it('refuses to change the case’s identity', async () => {
      expect(
        await refused(
          `UPDATE "official_submissions" SET "document_id" = gen_random_uuid() WHERE "id" = $1::uuid`,
          submissionId,
        ),
      ).toContain('immutable');
    });
  });

  describe('status moves only along the state machine (§121, §46, §47)', () => {
    it('refuses a decision that skips the workflow', async () => {
      await decide(university.owner.client, university.organizationId, revisionId, {
        toStatus: 'APPROVED',
      });
      expect(
        await refusedAsOrganization(
          `UPDATE "submission_revisions" SET "institution_decision_status" = 'UNDER_REVIEW'
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('already decided');
    });

    it('refuses a decision on a revision that was never handed over', async () => {
      // §5, §130: the two vocabularies are separate, and a decision on a
      // revision that is not READY would mean an institution decided about
      // something it was never shown.
      const orphan = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(orphan.processingStatus).toBe('READY');

      expect(
        await refused(
          `UPDATE "submission_revisions" SET "processing_status" = 'PREPARING' WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('cannot leave READY');
    });

    it('refuses a decision status outside the fixed vocabulary', async () => {
      // §4: no hidden equivalents. PASSED is not a thing PalCert says.
      expect(
        await refusedAsOrganization(
          `UPDATE "submission_revisions" SET "institution_decision_status" = 'PASSED'
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('cannot move from SUBMITTED to PASSED');
    });
  });

  describe('history is append-only (§42, §44, §123)', () => {
    it('refuses to rewrite or delete a decision event', async () => {
      const event = await context.adminDb.submissionDecisionEvent.findFirstOrThrow({
        where: { submissionRevisionId: revisionId },
      });
      expect(
        await refused(
          `UPDATE "submission_decision_events" SET "to_status" = 'APPROVED' WHERE "id" = $1::uuid`,
          event.id,
        ),
      ).toContain('immutable');
      expect(
        await refused(`DELETE FROM "submission_decision_events" WHERE "id" = $1::uuid`, event.id),
      ).toContain('immutable');
    });

    it('refuses to rewrite or delete a comment', async () => {
      await decide(university.owner.client, university.organizationId, revisionId, {
        toStatus: 'REJECTED',
        comment: 'The abstract is missing.',
      });
      const comment = await context.adminDb.submissionComment.findFirstOrThrow({
        where: { submissionRevisionId: revisionId },
      });
      expect(
        await refused(
          `UPDATE "submission_comments" SET "body" = 'Actually it is fine' WHERE "id" = $1::uuid`,
          comment.id,
        ),
      ).toContain('immutable');
    });

    it('refuses a SYSTEM event that claims a human made it', async () => {
      // §43: the two sources have different shapes, and the database knows the
      // difference rather than trusting the writer.
      expect(
        await refused(
          `INSERT INTO "submission_decision_events"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "event_source",
              "from_status", "to_status", "actor_user_id", "created_at")
           SELECT gen_random_uuid(), r."id", r."owner_user_id", r."organization_id", 'SYSTEM',
                  'SUBMITTED', 'APPROVED', r."owner_user_id", now()
           FROM "submission_revisions" r WHERE r."id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('violates check constraint');
    });

    it('refuses an ORGANIZATION event with no actor', async () => {
      expect(
        await refused(
          `INSERT INTO "submission_decision_events"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "event_source",
              "from_status", "to_status", "actor_user_id", "created_at")
           SELECT gen_random_uuid(), r."id", r."owner_user_id", r."organization_id", 'ORGANIZATION',
                  'SUBMITTED', 'APPROVED', NULL, now()
           FROM "submission_revisions" r WHERE r."id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('violates check constraint');
    });

    it('refuses a comment from the submitter’s side', async () => {
      // §68: Phase 14 models the institution side only, and the table being
      // dual-party is not a reason to quietly allow the other one.
      expect(
        await refused(
          `INSERT INTO "submission_comments"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "author_side",
              "author_user_id", "body", "created_at")
           SELECT gen_random_uuid(), r."id", r."owner_user_id", r."organization_id", 'SUBMITTER',
                  r."owner_user_id", 'Let me explain', now()
           FROM "submission_revisions" r WHERE r."id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('violates check constraint');
    });

    it('refuses an empty or oversized comment', async () => {
      for (const body of ["''", `repeat('x', 4001)`]) {
        expect(
          await refused(
            `INSERT INTO "submission_comments"
               ("id", "submission_revision_id", "owner_user_id", "organization_id", "author_side",
                "author_user_id", "body", "created_at")
             SELECT gen_random_uuid(), r."id", r."owner_user_id", r."organization_id",
                    'ORGANIZATION', r."owner_user_id", ${body}, now()
             FROM "submission_revisions" r WHERE r."id" = $1::uuid`,
            revisionId,
          ),
        ).toContain('violates check constraint');
      }
    });
  });

  describe('the shape of a case (§6, §95, §126, §127)', () => {
    it('allows one case per author, organization and document', async () => {
      expect(
        await refused(
          `INSERT INTO "official_submissions"
             ("id", "owner_user_id", "organization_id", "document_type_id", "document_id",
              "organization_name", "document_type_name", "created_at", "updated_at")
           SELECT gen_random_uuid(), s."owner_user_id", s."organization_id", s."document_type_id",
                  s."document_id", s."organization_name", s."document_type_name", now(), now()
           FROM "official_submissions" s WHERE s."id" = $1::uuid`,
          submissionId,
        ),
      ).toContain('already exists');
    });

    it('allows one revision number per case, and one check per case', async () => {
      const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });

      expect(
        await refused(
          `INSERT INTO "submission_revisions"
             ("id", "submission_id", "owner_user_id", "organization_id", "revision_number",
              "source_document_version_id", "source_document_sha256", "source_document_format",
              "document_version_number", "source_check_id", "source_check_run_id",
              "source_report_id", "source_report_hash", "source_evaluation_hash",
              "standard_id", "standard_version_id", "standard_content_hash",
              "standard_code", "standard_name", "standard_version_label",
              "determination", "score_complete", "total_rules", "passed_rules", "failed_rules",
              "review_required_rules", "indeterminate_rules", "not_applicable_rules",
              "processing_status", "created_at", "updated_at")
           SELECT gen_random_uuid(), r."submission_id", r."owner_user_id", r."organization_id",
                  r."revision_number", r."source_document_version_id", r."source_document_sha256",
                  r."source_document_format", r."document_version_number", gen_random_uuid(),
                  r."source_check_run_id", r."source_report_id", r."source_report_hash",
                  r."source_evaluation_hash", r."standard_id", r."standard_version_id",
                  r."standard_content_hash", r."standard_code", r."standard_name",
                  r."standard_version_label", r."determination", r."score_complete",
                  r."total_rules", r."passed_rules", r."failed_rules", r."review_required_rules",
                  r."indeterminate_rules", r."not_applicable_rules", 'PREPARING', now(), now()
           FROM "submission_revisions" r WHERE r."id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('already exists');

      expect(revision.revisionNumber).toBe(1);
    });

    it('requires a READY revision to have everything a handoff means', async () => {
      // §33, §130: READY, the snapshots, the evidence hash and SUBMITTED are
      // one state. A row that has some of them is describing a handoff that
      // half happened.
      expect(
        await refusedAsOrganization(
          `UPDATE "submission_revisions" SET "institution_decision_status" = NULL
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('violates check constraint');
    });

    it('requires the snapshot digest to equal the source digest', async () => {
      // §30: a copy's hash is the original's hash. A row saying otherwise
      // describes bytes nobody checked.
      expect(
        await refused(
          `INSERT INTO "submission_revisions"
             ("id", "submission_id", "owner_user_id", "organization_id", "revision_number",
              "source_document_version_id", "source_document_sha256", "source_document_format",
              "document_version_number", "source_check_id", "source_check_run_id",
              "source_report_id", "source_report_hash", "source_evaluation_hash",
              "standard_id", "standard_version_id", "standard_content_hash",
              "standard_code", "standard_name", "standard_version_label",
              "determination", "score_complete", "total_rules", "passed_rules", "failed_rules",
              "review_required_rules", "indeterminate_rules", "not_applicable_rules",
              "processing_status", "document_snapshot_sha256", "created_at", "updated_at")
           SELECT gen_random_uuid(), r."submission_id", r."owner_user_id", r."organization_id",
                  2, r."source_document_version_id", r."source_document_sha256",
                  r."source_document_format", r."document_version_number", gen_random_uuid(),
                  r."source_check_run_id", r."source_report_id", r."source_report_hash",
                  r."source_evaluation_hash", r."standard_id", r."standard_version_id",
                  r."standard_content_hash", r."standard_code", r."standard_name",
                  r."standard_version_label", r."determination", r."score_complete",
                  r."total_rules", r."passed_rules", r."failed_rules", r."review_required_rules",
                  r."indeterminate_rules", r."not_applicable_rules", 'PREPARING',
                  repeat('e', 64), now(), now()
           FROM "submission_revisions" r WHERE r."id" = $1::uuid`,
          revisionId,
        ),
      ).toContain('violates check constraint');
    });
  });

  describe('the evidence hash covers evidence, not opinions (§137, §138)', () => {
    it('is reproducible from the stored row', async () => {
      const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });

      expect(revision.evidenceSchemaVersion).toBe(SUBMISSION_EVIDENCE_SCHEMA_VERSION);
      expect(revision.evidenceCanonicalizationVersion).toBe(
        SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
      );

      const submission = await context.adminDb.officialSubmission.findUniqueOrThrow({
        where: { id: revision.submissionId },
      });

      const recomputed = computeSubmissionEvidenceHash({
        evidenceSchemaVersion: SUBMISSION_EVIDENCE_SCHEMA_VERSION,
        evidenceCanonicalizationVersion: SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
        organizationId: revision.organizationId,
        documentTypeId: submission.documentTypeId,
        documentId: submission.documentId,
        revisionNumber: revision.revisionNumber,
        documentVersionId: revision.sourceDocumentVersionId,
        documentSha256: revision.sourceDocumentSha256,
        documentFormat: revision.sourceDocumentFormat as 'DOCX',
        checkId: revision.sourceCheckId,
        checkRunId: revision.sourceCheckRunId,
        reportId: revision.sourceReportId,
        reportHash: revision.sourceReportHash,
        evaluationHash: revision.sourceEvaluationHash,
        determination: revision.determination as 'COMPLIANT',
        standardId: revision.standardId,
        standardVersionId: revision.standardVersionId,
        standardContentHash: revision.standardContentHash,
      });
      expect(recomputed).toBe(revision.evidenceHash);
    });

    it('does not change when the institution decides', async () => {
      // §138: the evidence is what was handed over. A decision is what
      // happened afterwards, and a hash that moved when a reviewer pressed
      // Approve would be covering the wrong thing.
      const before = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });

      await decide(university.owner.client, university.organizationId, revisionId, {
        toStatus: 'APPROVED',
      });

      const after = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(after.institutionDecisionStatus).toBe('APPROVED');
      expect(after.evidenceHash).toBe(before.evidenceHash);
    });
  });

  describe('a submission touches no money at all (§146–§150)', () => {
    it('writes no ledger entry, no purchase and no charge', async () => {
      const before = {
        entries: await context.adminDb.creditLedgerEntry.count(),
        purchases: await context.adminDb.servicePurchase.count(),
      };

      await decide(university.owner.client, university.organizationId, revisionId, {
        toStatus: 'APPROVED',
      });

      expect(await context.adminDb.creditLedgerEntry.count()).toBe(before.entries);
      expect(await context.adminDb.servicePurchase.count()).toBe(before.purchases);
    });

    it('keeps the submitted bytes alive with a lock of its own', async () => {
      // §38: an official submission that cannot produce the document it handed
      // over is evidence of nothing, so it does not borrow the check's lock.
      const locks = await context.adminDb.documentRetentionLock.findMany({
        where: { reference: revisionId },
      });
      expect(locks).toHaveLength(1);
      expect(locks[0]?.lockType).toBe('OFFICIAL_SUBMISSION');
    });
  });
});
