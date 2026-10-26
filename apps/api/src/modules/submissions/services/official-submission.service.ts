import { Injectable } from '@nestjs/common';
import {
  AppError,
  InstitutionDecisionStatus,
  PalCertErrorCode,
  ProcessingJobType,
  SubmissionProcessingStatus,
} from '@palcert/contracts';
import type { OfficialSubmission, SubmissionRevision } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import {
  SubmissionEligibilityService,
  type SubmittableCheck,
} from './submission-eligibility.service';

/** The lock that keeps submitted bytes alive independently of the check (§38). */
export const SUBMISSION_RETENTION_LOCK = 'OFFICIAL_SUBMISSION';

export interface CreateSubmissionInput {
  readonly checkId: string;
  readonly idempotencyKey?: string;
}

export interface CreatedSubmission {
  readonly submission: OfficialSubmission;
  readonly revision: SubmissionRevision;
  readonly created: boolean;
}

/**
 * Creating an official submission, and each later revision of one (§20, §33).
 *
 * Three things this service is careful about.
 *
 * **It is never automatic.** Nothing here is called by a check completing, a
 * SmartFix finishing, a payment settling or an AI review returning. A person
 * pressed a button, and that press is the sharing authorization — which is
 * exactly why no organization membership is required of them (§17, §20).
 *
 * **It copies nothing itself.** The transaction writes identity and a durable
 * intent, and returns. The bytes are copied by a worker, because a copy is
 * storage work that can fail halfway and a half-copied official handoff must
 * never be visible to an institution (§32, §33).
 *
 * **It transforms nothing.** Submission does not fix, reanalyze, re-evaluate,
 * rewrite or run AI over anything (§31). The report handed over is the report
 * the author already has, and the determination is copied from the completed
 * run rather than recomputed (§145).
 */
@Injectable()
export class OfficialSubmissionService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly eligibility: SubmissionEligibilityService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OfficialSubmissionService.name);
  }

  /**
   * Submit a completed check officially, creating the case if it is the first.
   *
   * Returns 202-shaped: the revision exists and is PREPARING, and no
   * organization can see it yet.
   */
  async submit(userId: string, input: CreateSubmissionInput): Promise<CreatedSubmission> {
    if (input.idempotencyKey !== undefined) {
      const existing = await this.tenant.withUser(userId, (tx) =>
        tx.submissionRevision.findFirst({
          where: { ownerUserId: userId, idempotencyKey: input.idempotencyKey },
          include: { submission: true },
        }),
      );
      if (existing !== null) {
        // §96: the same key and the same payload is the same submission, the
        // same revision and the same job. A different payload is a mistake
        // worth naming rather than a second official handoff.
        if (existing.sourceCheckId !== input.checkId) {
          throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
            message: 'That idempotency key was already used for a different submission.',
          });
        }
        return { submission: existing.submission, revision: existing, created: false };
      }
    }

    const check = await this.eligibility.submittableCheck(userId, input.checkId);
    // Outside the transaction: it reads the organization's public status
    // columns over a different connection, and holding a write transaction
    // open across that would widen a window for no reason.
    await this.eligibility.assertOrganizationEligible(check.organizationId);

    const submissionId = randomUUID();
    const revisionId = randomUUID();

    const result = await this.tenant.withUser(userId, async (tx) => {
      // §6, §128: one case per author, organization and document — so two
      // requests arriving together must not both find no case and both create
      // one. There is no row to lock yet, so the lock is on the identity
      // instead: an advisory lock held for this transaction, keyed on the
      // triple the unique index is built from. Without it the loser raises a
      // unique violation, and a violation cannot be recovered from inside the
      // transaction it aborted.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`submission:${userId}:${check.organizationId}:${check.documentId}`}))::text`;

      const existingCase = await this.eligibility.findCase(tx, {
        ownerUserId: userId,
        organizationId: check.organizationId,
        documentId: check.documentId,
      });

      if (existingCase !== null) {
        return this.addRevision(tx, {
          userId,
          submission: existingCase,
          check,
          revisionId,
          idempotencyKey: input.idempotencyKey,
        });
      }

      const submission = await tx.officialSubmission.create({
        data: {
          id: submissionId,
          ownerUserId: userId,
          organizationId: check.organizationId,
          documentTypeId: check.documentTypeId,
          documentId: check.documentId,
          organizationName: check.organizationName,
          documentTypeName: check.documentTypeName,
        },
      });

      const revision = await this.writeRevision(tx, {
        userId,
        submissionId: submission.id,
        revisionId,
        revisionNumber: 1,
        check,
        idempotencyKey: input.idempotencyKey,
      });

      return { submission, revision, created: true };
    });

    if (result.created) {
      const job = await this.jobs.findByResource(
        ProcessingJobType.SUBMISSION_PREPARE,
        result.revision.id,
      );
      if (job !== null) await this.dispatcher.dispatchNow(job.id);

      await this.events.audit({
        action: 'OFFICIAL_SUBMISSION_REQUESTED',
        actorUserId: userId,
        targetType: 'SubmissionRevision',
        targetId: result.revision.id,
        // Ids and status only: never a document title, a filename or a
        // comment (§116, §118).
        afterState: {
          submissionId: result.submission.id,
          organizationId: result.submission.organizationId,
          revisionNumber: result.revision.revisionNumber,
        },
      });
    }

    return result;
  }

  /**
   * A new revision of an existing case (§49).
   *
   * Allowed only where the institution asked for one. A case whose current
   * revision is SUBMITTED or UNDER_REVIEW is with the reviewer, and sending a
   * second document while they are reading the first would make "the current
   * official revision" meaningless; a case that is APPROVED or REJECTED is
   * finished.
   */
  private async addRevision(
    tx: TenantClient,
    params: {
      userId: string;
      submission: OfficialSubmission;
      check: SubmittableCheck;
      revisionId: string;
      idempotencyKey: string | undefined;
    },
  ): Promise<CreatedSubmission> {
    // §126, §128: serialize concurrent resubmissions on the case row, so two
    // requests cannot read the same maximum revision number. The unique index
    // catches it even if this lock is ever lost; the lock is what turns a
    // crash into a queue.
    await tx.$queryRaw`SELECT "id" FROM "official_submissions" WHERE "id" = ${params.submission.id}::uuid FOR UPDATE`;

    // §95 first, deliberately. Submitting the same check again is a mistake
    // worth naming even when the case is also in a state that would refuse a
    // revision anyway: "you already submitted that" is what happened, and
    // "the organization has not asked for a revised version" is not.
    await this.assertCheckNotAlreadySubmitted(tx, params.submission.id, params.check.checkId);

    // The latest revision of the case, read under the lock — not the case's
    // `currentRevisionId`. The two differ exactly when it matters: the pointer
    // advances only once a revision reaches READY, so a revision that is still
    // PREPARING is invisible to it. Deciding from the pointer let two
    // simultaneous resubmissions both see a REVISION_REQUESTED revision and
    // both be accepted, which is how a case ended up with revisions 2 and 3
    // in flight at once (§127, §128).
    const latest = await tx.submissionRevision.findFirst({
      where: { submissionId: params.submission.id },
      orderBy: { revisionNumber: 'desc' },
    });

    if (latest === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_RESUBMISSION_NOT_ALLOWED, {
        message: 'This submission is still being prepared.',
      });
    }

    if (latest.processingStatus === SubmissionProcessingStatus.PREPARING) {
      // §37: retrying the preparation is the documented path. Starting a
      // second revision beside it is not.
      throw new AppError(PalCertErrorCode.SUBMISSION_RESUBMISSION_NOT_ALLOWED, {
        message: 'This submission is still being prepared.',
      });
    }

    if (latest.processingStatus === SubmissionProcessingStatus.FAILED) {
      // A preparation failure is not an institution decision (§35), and it is
      // not a revision request either. Nothing was handed over, so there is
      // nothing to revise.
      throw new AppError(PalCertErrorCode.SUBMISSION_RESUBMISSION_NOT_ALLOWED, {
        message: 'The previous submission could not be prepared. Retry it rather than revising it.',
        details: { failureCode: latest.failureCode },
      });
    }

    if (latest.institutionDecisionStatus !== InstitutionDecisionStatus.REVISION_REQUESTED) {
      throw new AppError(PalCertErrorCode.SUBMISSION_RESUBMISSION_NOT_ALLOWED, {
        message:
          latest.institutionDecisionStatus === InstitutionDecisionStatus.APPROVED ||
          latest.institutionDecisionStatus === InstitutionDecisionStatus.REJECTED
            ? 'This submission has already been decided.'
            : 'The organization has not asked for a revised version.',
        details: { institutionDecisionStatus: latest.institutionDecisionStatus },
      });
    }

    // §49: the same organization and the same document type. The database
    // enforces the document and the organization through composite foreign
    // keys; the document type is captured on the case and checked here,
    // because relabelling a Master's thesis as a PhD one during submission is
    // exactly what §16 forbids.
    if (params.check.documentTypeId !== params.submission.documentTypeId) {
      throw new AppError(PalCertErrorCode.SUBMISSION_DOCUMENT_MISMATCH, {
        message: 'A revision must be checked against the same document type.',
      });
    }

    const revision = await this.writeRevision(tx, {
      userId: params.userId,
      submissionId: params.submission.id,
      revisionId: params.revisionId,
      revisionNumber: latest.revisionNumber + 1,
      check: params.check,
      idempotencyKey: params.idempotencyKey,
    });

    return { submission: params.submission, revision, created: true };
  }

  /** Write one revision, its retention locks and its durable intent. */
  private async writeRevision(
    tx: TenantClient,
    params: {
      userId: string;
      submissionId: string;
      revisionId: string;
      revisionNumber: number;
      check: SubmittableCheck;
      idempotencyKey: string | undefined;
    },
  ): Promise<SubmissionRevision> {
    const { check } = params;

    await this.assertCheckNotAlreadySubmitted(tx, params.submissionId, check.checkId);

    const revision = await tx.submissionRevision.create({
      data: {
        id: params.revisionId,
        submissionId: params.submissionId,
        ownerUserId: params.userId,
        organizationId: check.organizationId,
        revisionNumber: params.revisionNumber,

        sourceDocumentVersionId: check.documentVersionId,
        sourceDocumentSha256: check.documentSha256,
        sourceDocumentFormat: check.documentFormat,
        documentVersionNumber: check.documentVersionNumber,

        sourceCheckId: check.checkId,
        sourceCheckRunId: check.checkRunId,
        sourceReportId: check.reportId,
        sourceReportHash: check.reportHash,
        sourceEvaluationHash: check.evaluationHash,

        standardId: check.standardId,
        standardVersionId: check.standardVersionId,
        standardContentHash: check.standardContentHash,
        standardCode: check.standardCode,
        standardName: check.standardName,
        standardVersionLabel: check.standardVersionLabel,

        determination: check.determination,
        scoreValue: check.scoreValue,
        scoreCoverage: check.scoreCoverage,
        scoreComplete: check.scoreComplete,
        totalRules: check.totalRules,
        passedRules: check.passedRules,
        failedRules: check.failedRules,
        reviewRequiredRules: check.reviewRequiredRules,
        indeterminateRules: check.indeterminateRules,
        notApplicableRules: check.notApplicableRules,

        processingStatus: SubmissionProcessingStatus.PREPARING,
        idempotencyKey: params.idempotencyKey ?? null,
      },
    });

    // §38: the submitted bytes must outlive the private check's lifecycle. An
    // official submission that cannot produce the document it handed over is
    // not evidence of anything, so it holds its own lock rather than relying
    // on the check's.
    await tx.documentRetentionLock.create({
      data: {
        documentVersionId: check.documentVersionId,
        ownerUserId: params.userId,
        lockType: SUBMISSION_RETENTION_LOCK,
        reference: revision.id,
      },
    });

    // The durable intent, written inside the same transaction as the row it
    // describes (§32, ADR-0036).
    await this.jobs.enqueueInTransaction(tx, {
      type: ProcessingJobType.SUBMISSION_PREPARE,
      resourceType: 'SUBMISSION_REVISION',
      resourceId: revision.id,
      ownerUserId: params.userId,
    });

    return revision;
  }

  /**
   * One check is one revision's evidence (§95).
   *
   * The unique index says this too; this says it with a code the person can
   * act on rather than a constraint name.
   */
  private async assertCheckNotAlreadySubmitted(
    tx: TenantClient,
    submissionId: string,
    checkId: string,
  ): Promise<void> {
    const duplicate = await tx.submissionRevision.findFirst({
      where: { submissionId, sourceCheckId: checkId },
    });
    if (duplicate !== null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_ALREADY_SUBMITTED, {
        message: 'That check has already been submitted to this organization.',
      });
    }
  }

  /** Advance the case pointer once a revision is really ready (§127). */
  async makeCurrent(userId: string, revisionId: string): Promise<void> {
    await this.tenant.withUser(userId, async (tx) => {
      const revision = await tx.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      await tx.officialSubmission.update({
        where: { id: revision.submissionId },
        data: { currentRevisionId: revision.id, updatedAt: this.clock.now() },
      });
    });
  }
}
