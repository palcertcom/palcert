import { PrismaClient } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import { type AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import { completedCheck, publishStandardFor, submitAndPrepare } from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { applyTestEnvironment } from './support/test-environment';

/**
 * Who may write what, proved at the layer that cannot be talked out of it.
 *
 * Every attempt in this file goes through the least-privileged application
 * role over raw SQL, with the session context set by hand. That is deliberate
 * and it is the point: the controller is not the boundary. If a future route,
 * a service bug, a migration script or somebody at a psql prompt could write
 * one of these rows, an institution's decision record would be forgeable and
 * nothing above the database would notice.
 *
 * Read access is dual-party. Write authority is not, and these are the
 * assertions that say so.
 */
describe('Official submissions — write authority (e2e)', () => {
  let context: TestContext;
  let restoreEnv: () => void;
  let app: PrismaClient;

  let author: { email: string; userId: string; client: AuthClient };
  let outsider: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let otherUniversity: TenantFixture;
  let standard: PublishedStandard;

  let submissionId: string;
  let revisionId: string;

  beforeAll(async () => {
    context = await createTestContext();
    restoreEnv = applyTestEnvironment();
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    await app.$connect();
  });

  afterAll(async () => {
    await app.$disconnect();
    restoreEnv();
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    outsider = await createUser(context, 'outsider@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    otherUniversity = await createTenant(context, 'Birzeit University', 'other@example.com');
    standard = await publishStandardFor(context, university);

    const check = await completedCheck(context, author, standard);
    const submitted = await submitAndPrepare(context, author.client, check.checkId);
    submissionId = submitted.submissionId;
    revisionId = submitted.revisionId;
  });

  /**
   * Run one statement under a chosen session context, exactly as the
   * application would establish it.
   *
   * `withUser` sets only the user; `withTenant` sets the organization too.
   * That difference is the discriminator the whole write-authority model turns
   * on: a caller with organization context is acting as the institution, and
   * one without it is acting as the submitter — which stays well defined even
   * when one person is both.
   */
  async function as(
    who: { userId: string; organizationId?: string },
    statement: (tx: PrismaClient) => Promise<unknown>,
  ): Promise<{ ok: boolean; error: string | null; affected: number }> {
    let affected = 0;
    try {
      await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_user_id', $1, true)`,
          who.userId,
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_organization_id', $1, true)`,
          who.organizationId ?? '',
        );
        const result = await statement(tx as unknown as PrismaClient);
        affected = typeof result === 'number' ? result : 0;
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        affected: 0,
      };
    }
    // A refusal is not always an exception. Row-level security removes rows
    // from a statement's reach rather than raising, so an UPDATE the policies
    // do not allow simply touches nothing — and a test that accepted silence
    // as success would pass on a database with no policies at all.
    return { ok: affected > 0, error: null, affected };
  }

  /** The receiving organization's reviewer context. */
  function reviewer(): { userId: string; organizationId: string } {
    return { userId: university.owner.userId, organizationId: university.organizationId };
  }

  describe('the organization cannot create the handoff', () => {
    it('refuses an organization-context INSERT of an official submission', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "official_submissions"
             ("id", "owner_user_id", "organization_id", "document_type_id", "document_id",
              "organization_name", "document_type_name", "created_at", "updated_at")
           SELECT $1::uuid, s."owner_user_id", s."organization_id", s."document_type_id",
                  s."document_id", s."organization_name", s."document_type_name", now(), now()
           FROM "official_submissions" s WHERE s."id" = $2::uuid`,
          randomUUID(),
          submissionId,
        ),
      );
      // Not an error message, a refusal: RLS makes the row invisible to the
      // INSERT policy, so nothing is written and nothing is disclosed.
      expect(attempt.ok).toBe(false);

      const count = await context.adminDb.officialSubmission.count();
      expect(count).toBe(1);
    });

    it('refuses an organization-context INSERT of a submission revision', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
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
           SELECT $1::uuid, r."submission_id", r."owner_user_id", r."organization_id", 99,
                  r."source_document_version_id", r."source_document_sha256",
                  r."source_document_format", r."document_version_number", r."source_check_id",
                  r."source_check_run_id", r."source_report_id", r."source_report_hash",
                  r."source_evaluation_hash", r."standard_id", r."standard_version_id",
                  r."standard_content_hash", r."standard_code", r."standard_name",
                  r."standard_version_label", r."determination", r."score_complete",
                  r."total_rules", r."passed_rules", r."failed_rules", r."review_required_rules",
                  r."indeterminate_rules", r."not_applicable_rules", 'PREPARING', now(), now()
           FROM "submission_revisions" r WHERE r."id" = $2::uuid`,
          randomUUID(),
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);

      const count = await context.adminDb.submissionRevision.count();
      expect(count).toBe(1);
    });
  });

  describe('the organization cannot rewrite what it received', () => {
    it('refuses to change the technical determination', async () => {
      const before = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      // Deliberately a value the revision does not already hold: a no-op
      // UPDATE would be allowed, and proves nothing.
      const forged = before.determination === 'COMPLIANT' ? 'NON_COMPLIANT' : 'COMPLIANT';

      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions" SET "determination" = $2, "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
          forged,
        ),
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.error).toContain('may change only its own decision');
      expect(
        (await context.adminDb.submissionRevision.findUniqueOrThrow({ where: { id: revisionId } }))
          .determination,
      ).toBe(before.determination);
    });

    it('refuses to change the deterministic score or its coverage', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions"
             SET "score_value" = '100.00', "score_coverage" = '100.00', "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.error).toContain('may change only its own decision');
    });

    it('refuses to change the report or evaluation hash', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions"
             SET "source_report_hash" = repeat('a', 64), "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
    });

    it('refuses to change the evidence snapshot', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions"
             SET "evidence_hash" = repeat('b', 64),
                 "document_snapshot_key" = 'organizations/forged/document',
                 "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);

      const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(row.evidenceHash).not.toBe('b'.repeat(64));
      expect(row.documentSnapshotKey).not.toBe('organizations/forged/document');
    });

    it('refuses to modify the case row at all', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "official_submissions" SET "updated_at" = now() WHERE "id" = $1::uuid`,
          submissionId,
        ),
      );
      expect(attempt.ok).toBe(false);
    });
  });

  describe('the submitter cannot write the institution’s decision', () => {
    it('refuses a submitter-context change of the decision status', async () => {
      const attempt = await as({ userId: author.userId }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions"
             SET "institution_decision_status" = 'APPROVED', "decided_at" = now(),
                 "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.error).toContain('cannot write an institution decision');

      const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(row.institutionDecisionStatus).toBe('SUBMITTED');
    });

    it('refuses a submitter-context INSERT of an institution decision event', async () => {
      const attempt = await as({ userId: author.userId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "submission_decision_events"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "event_source",
              "from_status", "to_status", "actor_user_id", "created_at")
           SELECT $1::uuid, r."id", r."owner_user_id", r."organization_id", 'ORGANIZATION',
                  'SUBMITTED', 'APPROVED', $2::uuid, now()
           FROM "submission_revisions" r WHERE r."id" = $3::uuid`,
          randomUUID(),
          author.userId,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);

      const events = await context.adminDb.submissionDecisionEvent.findMany({
        where: { submissionRevisionId: revisionId },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.toStatus).toBe('SUBMITTED');
      expect(events[0]?.eventSource).toBe('SYSTEM');
    });

    it('refuses a submitter-context forged SYSTEM event, flag and all', async () => {
      // The transaction-local flag the finalisation function uses is not a
      // capability: `palcert_app` may set any custom GUC, so the flag alone
      // buys nothing. The role switch is the real boundary.
      const attempt = await as({ userId: author.userId }, async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.submission_system_write', 'on', true)`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "submission_decision_events"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "event_source",
              "from_status", "to_status", "actor_user_id", "created_at")
           SELECT $1::uuid, r."id", r."owner_user_id", r."organization_id", 'SYSTEM',
                  NULL, 'SUBMITTED', NULL, now()
           FROM "submission_revisions" r WHERE r."id" = $2::uuid`,
          randomUUID(),
          revisionId,
        );
      });
      expect(attempt.ok).toBe(false);
    });

    it('refuses a submitter-context review comment', async () => {
      const attempt = await as({ userId: author.userId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "submission_comments"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "author_side",
              "author_user_id", "body", "created_at")
           SELECT $1::uuid, r."id", r."owner_user_id", r."organization_id", 'ORGANIZATION',
                  $2::uuid, 'Approved by me', now()
           FROM "submission_revisions" r WHERE r."id" = $3::uuid`,
          randomUUID(),
          author.userId,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
      expect(await context.adminDb.submissionComment.count()).toBe(0);
    });
  });

  describe('the organization can do exactly what it is for', () => {
    it('records a permitted decision transition, with itself as the actor', async () => {
      const attempt = await as(reviewer(), async (tx) => {
        const moved = await tx.$executeRawUnsafe(
          `UPDATE "submission_revisions"
             SET "institution_decision_status" = 'UNDER_REVIEW', "review_started_at" = now(),
                 "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
        );
        const recorded = await tx.$executeRawUnsafe(
          `INSERT INTO "submission_decision_events"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "event_source",
              "from_status", "to_status", "actor_user_id", "created_at")
           SELECT $1::uuid, r."id", r."owner_user_id", r."organization_id", 'ORGANIZATION',
                  'SUBMITTED', 'UNDER_REVIEW', $2::uuid, now()
           FROM "submission_revisions" r WHERE r."id" = $3::uuid`,
          randomUUID(),
          university.owner.userId,
          revisionId,
        );
        return moved + recorded;
      });
      expect(attempt.error).toBeNull();
      expect(attempt.affected).toBe(2);

      const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(row.institutionDecisionStatus).toBe('UNDER_REVIEW');
      // §2: the decision moved and nothing else did. The technical result the
      // institution was handed is exactly what it was.
      expect(row.evidenceHash).not.toBeNull();
    });

    it('refuses an event attributed to somebody other than the caller', async () => {
      // §71: the actor is the authenticated reviewer. A service that passed an
      // actor through from a request body could not put another name on a
      // decision even if it wanted to.
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "submission_decision_events"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "event_source",
              "from_status", "to_status", "actor_user_id", "created_at")
           SELECT $1::uuid, r."id", r."owner_user_id", r."organization_id", 'ORGANIZATION',
                  'SUBMITTED', 'APPROVED', $2::uuid, now()
           FROM "submission_revisions" r WHERE r."id" = $3::uuid`,
          randomUUID(),
          outsider.userId,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
    });

    it('refuses a comment attributed to somebody other than the caller', async () => {
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "submission_comments"
             ("id", "submission_revision_id", "owner_user_id", "organization_id", "author_side",
              "author_user_id", "body", "created_at")
           SELECT $1::uuid, r."id", r."owner_user_id", r."organization_id", 'ORGANIZATION',
                  $2::uuid, 'Not mine', now()
           FROM "submission_revisions" r WHERE r."id" = $3::uuid`,
          randomUUID(),
          outsider.userId,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
    });
  });

  describe('nobody else is a party to this at all', () => {
    it('shows another organization nothing, and lets it write nothing', async () => {
      const other = {
        userId: otherUniversity.owner.userId,
        organizationId: otherUniversity.organizationId,
      };

      const visible = await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_user_id', $1, true)`,
          other.userId,
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_organization_id', $1, true)`,
          other.organizationId,
        );
        return tx.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*)::bigint AS count FROM "submission_revisions"`,
        );
      });
      expect(Number(visible[0]?.count ?? -1)).toBe(0);

      const attempt = await as(other, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions"
             SET "institution_decision_status" = 'APPROVED', "updated_at" = now()
           WHERE "id" = $1::uuid`,
          revisionId,
        ),
      );
      expect(attempt.ok).toBe(false);
      expect(
        (await context.adminDb.submissionRevision.findUniqueOrThrow({ where: { id: revisionId } }))
          .institutionDecisionStatus,
      ).toBe('SUBMITTED');
    });

    it('shows another user nothing, and lets them write nothing', async () => {
      const visible = await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_user_id', $1, true)`,
          outsider.userId,
        );
        return tx.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*)::bigint AS count FROM "official_submissions"`,
        );
      });
      expect(Number(visible[0]?.count ?? -1)).toBe(0);

      await as({ userId: outsider.userId }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_revisions" SET "updated_at" = now() WHERE "id" = $1::uuid`,
          revisionId,
        ),
      );
      const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(row.ownerUserId).toBe(author.userId);
    });
  });

  describe('history is append-only, and nobody holds DELETE', () => {
    it('refuses to rewrite a decision event', async () => {
      const event = await context.adminDb.submissionDecisionEvent.findFirstOrThrow({
        where: { submissionRevisionId: revisionId },
      });
      const attempt = await as(reviewer(), (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "submission_decision_events" SET "to_status" = 'APPROVED' WHERE "id" = $1::uuid`,
          event.id,
        ),
      );
      expect(attempt.ok).toBe(false);
    });

    it('refuses to delete a submission, a revision or its history', async () => {
      for (const table of [
        'submission_comments',
        'submission_decision_events',
        'submission_revisions',
        'official_submissions',
      ]) {
        const attempt = await as(reviewer(), (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM "${table}"`),
        );
        expect(attempt.ok).toBe(false);
      }
    });
  });
});
