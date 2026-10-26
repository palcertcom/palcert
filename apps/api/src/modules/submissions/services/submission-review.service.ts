import { Injectable } from '@nestjs/common';
import {
  AppError,
  InstitutionDecisionStatus,
  PalCertErrorCode,
  SUBMISSION_COMMENT_MAX_LENGTH,
  SubmissionCommentSide,
  SubmissionEventSource,
  ProcessingJobType,
  SubmissionProcessingStatus,
  decisionRequiresComment,
  isValidDecisionTransition,
  type DocumentFormat,
  type OrganizationSubmissionRevisionView,
  type OrganizationSubmissionView,
  type SubmissionCommentView,
  type SubmissionDecisionEventView,
  type SubmissionDecisionReason,
  type SubmissionQueueEntryView,
  type SubmitterIdentityView,
} from '@palcert/contracts';
import type { SubmissionRevision } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { CertificateSchedulingService } from '../../certificates/services/certificate-scheduling.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { commentView, eventView, standardView, technicalView } from './submission-read.service';

export interface DecisionInput {
  readonly toStatus: InstitutionDecisionStatus;
  readonly reasonCode?: SubmissionDecisionReason;
  readonly comment?: string;
  /** The revision version the reviewer was looking at, from `If-Match` (§72). */
  readonly expectedStatus?: InstitutionDecisionStatus;
}

/**
 * The receiving institution's side of a submission (§46, §53).
 *
 * Three boundaries hold this service in place, and none of them is this file:
 *
 * **What it can see.** Every query runs under `withTenant`, so the dual-party
 * policies decide which rows exist at all. There is no query here that reaches
 * a document, a check, a report row, an analysis, an AI review, a SmartFix plan
 * or anything financial, and if one were added the policies on those tables
 * would refuse it anyway (§25, §74).
 *
 * **What it can write.** The column-authority trigger lets an organization
 * context change the decision fields of a revision and nothing else. The
 * determination, the score, the report hash and the evidence hash are refused
 * by the database, not by this code (§2, §3).
 *
 * **Who may do it.** Permissions, never role names (§53, §54). A
 * TEMPLATE_MANAGER holds none of these and so decides nothing, which is a fact
 * about the role bundles rather than a check written here.
 */
@Injectable()
export class SubmissionReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly certificates: CertificateSchedulingService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly domainEvents: DomainEventService,
  ) {}

  /**
   * The review queue (§56).
   *
   * Only revisions that reached READY appear, because a PREPARING one has not
   * been handed over yet and a FAILED one never will be — a storage failure is
   * not something for an institution to decide about (§5, §35).
   */
  async queue(
    context: TenantContext,
    filter: { status?: InstitutionDecisionStatus } = {},
  ): Promise<SubmissionQueueEntryView[]> {
    const rows = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.submissionRevision.findMany({
          where: {
            organizationId: context.organizationId,
            processingStatus: SubmissionProcessingStatus.READY,
            institutionDecisionStatus: filter.status ?? { not: null },
          },
          orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
          include: { submission: true },
        }),
    );

    const submitters = await this.submitters(
      context,
      rows.map((revision) => revision.submissionId),
    );

    return rows.map((revision) => ({
      submissionId: revision.submissionId,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      documentTypeId: revision.submission.documentTypeId,
      documentTypeName: revision.submission.documentTypeName,
      institutionDecisionStatus: revision.institutionDecisionStatus as InstitutionDecisionStatus,
      technical: technicalView(revision),
      standardCode: revision.standardCode,
      standardVersionLabel: revision.standardVersionLabel,
      submitter: submitters.get(revision.submissionId) ?? unknownSubmitter(revision.ownerUserId),
      submittedAt: (revision.submittedAt ?? revision.createdAt).toISOString(),
      decidedAt: revision.decidedAt?.toISOString() ?? null,
    }));
  }

  /** One case, with every revision it has received. */
  async get(context: TenantContext, submissionId: string): Promise<OrganizationSubmissionView> {
    const row = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.officialSubmission.findFirst({
          where: { id: submissionId, organizationId: context.organizationId },
          include: { revisions: { orderBy: { revisionNumber: 'desc' } } },
        }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_NOT_FOUND, {
        message: 'That submission does not exist.',
      });
    }

    // §36: only what was really handed over. A revision still preparing, or one
    // whose preparation failed, is not part of this organization's business.
    const handedOver = row.revisions.filter(
      (revision) => revision.processingStatus === SubmissionProcessingStatus.READY,
    );

    const submitters = await this.submitters(context, [row.id]);

    return {
      id: row.id,
      organizationId: row.organizationId,
      documentTypeId: row.documentTypeId,
      documentTypeName: row.documentTypeName,
      submitter: submitters.get(row.id) ?? unknownSubmitter(row.ownerUserId),
      currentRevisionId: row.currentRevisionId ?? '',
      revisions: handedOver.map((revision) =>
        organizationRevisionView(revision, row.currentRevisionId),
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Record one institution decision (§46, §71).
   *
   * The whole thing is one transaction over a locked row: read the current
   * status under `FOR UPDATE`, validate the transition against it, write the
   * new status, append the event, and append the comment the decision
   * required. Two reviewers pressing Approve and Reject at the same moment
   * therefore produce one decision and one conflict, never two events
   * disagreeing about what the institution said.
   */
  async decide(
    context: TenantContext,
    revisionId: string,
    input: DecisionInput,
  ): Promise<SubmissionDecisionEventView> {
    const body = input.comment?.trim() ?? '';

    // §69: REJECTED and REVISION_REQUESTED are the two the author has to act
    // on, so neither may arrive as a bare status change.
    if (decisionRequiresComment(input.toStatus) && body.length === 0) {
      throw new AppError(PalCertErrorCode.SUBMISSION_COMMENT_REQUIRED, {
        message: 'This decision requires a comment explaining it.',
        details: { toStatus: input.toStatus },
      });
    }
    if (body.length > SUBMISSION_COMMENT_MAX_LENGTH) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: `A comment may be at most ${SUBMISSION_COMMENT_MAX_LENGTH} characters.`,
      });
    }

    const now = this.clock.now();
    let scheduledCertificateId: string | null = null;

    const event = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const revision = await this.lock(tx, context.organizationId, revisionId);

        const from = revision.institutionDecisionStatus as InstitutionDecisionStatus | null;
        if (revision.processingStatus !== SubmissionProcessingStatus.READY || from === null) {
          // §5, §35: a submission still being prepared is not a submission the
          // institution has been shown, so there is nothing here to decide.
          throw new AppError(PalCertErrorCode.SUBMISSION_NOT_READY, {
            message: 'That submission has not been handed over yet.',
          });
        }

        // §72: the reviewer acted on what they read. If somebody else moved it
        // since, they are deciding about a different thing.
        if (input.expectedStatus !== undefined && input.expectedStatus !== from) {
          throw new AppError(PalCertErrorCode.SUBMISSION_REVISION_CONFLICT, {
            message: 'This submission changed while you were reviewing it.',
            details: { institutionDecisionStatus: from },
          });
        }

        if (!isValidDecisionTransition(from, input.toStatus)) {
          const code =
            from === InstitutionDecisionStatus.APPROVED ||
            from === InstitutionDecisionStatus.REJECTED ||
            from === InstitutionDecisionStatus.REVISION_REQUESTED
              ? PalCertErrorCode.SUBMISSION_ALREADY_DECIDED
              : PalCertErrorCode.SUBMISSION_INVALID_TRANSITION;
          throw new AppError(code, {
            message: 'That decision is not available from the submission’s current state.',
            details: { fromStatus: from, toStatus: input.toStatus },
          });
        }

        const decided =
          input.toStatus !== InstitutionDecisionStatus.UNDER_REVIEW ? now : revision.decidedAt;

        await tx.submissionRevision.update({
          where: { id: revision.id },
          data: {
            institutionDecisionStatus: input.toStatus,
            reviewStartedAt:
              input.toStatus === InstitutionDecisionStatus.UNDER_REVIEW
                ? (revision.reviewStartedAt ?? now)
                : revision.reviewStartedAt,
            decidedAt: decided,
            updatedAt: now,
          },
        });

        if (body.length > 0) {
          await tx.submissionComment.create({
            data: {
              id: randomUUID(),
              submissionRevisionId: revision.id,
              ownerUserId: revision.ownerUserId,
              organizationId: revision.organizationId,
              authorSide: SubmissionCommentSide.ORGANIZATION,
              authorUserId: context.userId,
              body,
            },
          });
        }

        // §42: the history is the authority, and the actor is the
        // authenticated reviewer — taken from the verified tenant context, not
        // from anything the request body said.
        const decision = await tx.submissionDecisionEvent.create({
          data: {
            id: randomUUID(),
            submissionRevisionId: revision.id,
            ownerUserId: revision.ownerUserId,
            organizationId: revision.organizationId,
            eventSource: SubmissionEventSource.ORGANIZATION,
            actorUserId: context.userId,
            fromStatus: from,
            toStatus: input.toStatus,
            reasonCode: input.reasonCode ?? null,
          },
        });

        // Phase 15 §72: an approval of a compliant submission creates its
        // certificate intent *here*, in the decision transaction, and only
        // once the approval event it depends on exists — the database refuses
        // to claim a certificate for a revision with no organization approval,
        // which is exactly the check that caught this being done too early.
        //
        // Inside the transaction rather than after it, because committing the
        // approval and then enqueueing separately looks equivalent and is not:
        // a crash between the two leaves an approved, compliant submission
        // that nothing will ever certify, and the person waiting for it cannot
        // tell that from slow. Reconciliation is the safety net, not the
        // mechanism.
        //
        // The reviewer waits for none of the real work: this writes a row and
        // a job, and the rendering happens later.
        if (input.toStatus === InstitutionDecisionStatus.APPROVED) {
          scheduledCertificateId = await this.certificates.scheduleIfEligible(tx, {
            id: revision.id,
            ownerUserId: revision.ownerUserId,
            processingStatus: revision.processingStatus,
            determination: revision.determination,
            institutionDecisionStatus: input.toStatus,
          });
        }

        // Phase 16 §15, §21: the notification's source of truth is the
        // decision event, and the event is emitted in the same transaction
        // that wrote it. The inline comment above gets no event of its own —
        // it is part of this decision, and telling the author twice about one
        // act would be two notifications for one thing that happened.
        await this.domainEvents.emitDecision(tx, decision.id);

        return decision;
      },
    );

    // Committed, so the intent is durable. Nudging the queue now only makes
    // it prompt; the job exists either way.
    if (scheduledCertificateId !== null) {
      const job = await this.jobs.findByResource(
        ProcessingJobType.CERTIFICATE_ISSUE,
        scheduledCertificateId,
      );
      if (job !== null) await this.dispatcher.dispatchNow(job.id);

      await this.events.audit({
        action: 'CERTIFICATE_ISSUANCE_SCHEDULED',
        actorUserId: context.userId,
        targetType: 'ComplianceCertificate',
        targetId: scheduledCertificateId,
        afterState: { organizationId: context.organizationId, revisionId },
      });
    }

    await this.events.audit({
      action: 'SUBMISSION_DECISION_RECORDED',
      actorUserId: context.userId,
      targetType: 'SubmissionRevision',
      targetId: revisionId,
      // §117: ids, statuses and codes. Never the comment, and never a title.
      afterState: {
        organizationId: context.organizationId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reasonCode: event.reasonCode,
      },
    });

    return eventView(event);
  }

  /**
   * A review comment on its own (§65).
   *
   * Comments are communication, not decisions: writing one moves nothing, and
   * the status the author sees is unchanged (§70).
   */
  async comment(
    context: TenantContext,
    revisionId: string,
    body: string,
  ): Promise<SubmissionCommentView> {
    const text = body.trim();
    if (text.length === 0 || text.length > SUBMISSION_COMMENT_MAX_LENGTH) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: `A comment must be between 1 and ${SUBMISSION_COMMENT_MAX_LENGTH} characters.`,
      });
    }

    const row = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const revision = await this.lock(tx, context.organizationId, revisionId);
        if (revision.processingStatus !== SubmissionProcessingStatus.READY) {
          throw new AppError(PalCertErrorCode.SUBMISSION_NOT_READY, {
            message: 'That submission has not been handed over yet.',
          });
        }
        const created = await tx.submissionComment.create({
          data: {
            id: randomUUID(),
            submissionRevisionId: revision.id,
            ownerUserId: revision.ownerUserId,
            organizationId: revision.organizationId,
            authorSide: SubmissionCommentSide.ORGANIZATION,
            authorUserId: context.userId,
            body: text,
          },
        });

        // Phase 16 §21: a standalone comment is its own event. The one
        // `decide()` writes alongside a decision is not — that one is part of
        // the decision, and is reported by it.
        //
        // The event carries the submission and revision ids and nothing else.
        // What the reviewer wrote requires signing in, which is also why the
        // audit record above says only that a comment exists.
        await this.domainEvents.emitComment(tx, created.id);

        return created;
      },
    );

    await this.events.audit({
      action: 'SUBMISSION_COMMENT_ADDED',
      actorUserId: context.userId,
      targetType: 'SubmissionRevision',
      targetId: revisionId,
      // §117, §118: that a comment was written, never what it said. An audit
      // log is read by people who are not party to the submission.
      afterState: { organizationId: context.organizationId, commentId: row.id },
    });

    return commentView(row);
  }

  /** The decision history of one revision this organization received. */
  async history(
    context: TenantContext,
    revisionId: string,
  ): Promise<SubmissionDecisionEventView[]> {
    const rows = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.submissionDecisionEvent.findMany({
          where: { submissionRevisionId: revisionId, organizationId: context.organizationId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    );
    return rows.map(eventView);
  }

  /** The comments on one revision this organization received. */
  async comments(context: TenantContext, revisionId: string): Promise<SubmissionCommentView[]> {
    const rows = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.submissionComment.findMany({
          where: { submissionRevisionId: revisionId, organizationId: context.organizationId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    );
    return rows.map(commentView);
  }

  /**
   * Who submitted these cases, as far as an institution is allowed to know
   * (§85, §87).
   *
   * `users` is USER_SCOPED and is not widened for this. The disclosure goes
   * through `app_submission_submitters`, whose WHERE clause is the
   * authorization boundary: three columns, only for submissions really handed
   * to the caller's own organization.
   */
  private async submitters(
    context: TenantContext,
    submissionIds: readonly string[],
  ): Promise<Map<string, SubmitterIdentityView>> {
    if (submissionIds.length === 0) return new Map();

    const rows = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.$queryRaw<
          { submission_id: string; user_id: string; display_name: string | null; email: string }[]
        >`SELECT * FROM app_submission_submitters(${[...new Set(submissionIds)]}::uuid[])`,
    );

    return new Map(
      rows.map((row) => [
        row.submission_id,
        { userId: row.user_id, displayName: row.display_name, email: row.email },
      ]),
    );
  }

  /** One revision of this organization's, locked for the decision about it. */
  private async lock(
    tx: TenantClient,
    organizationId: string,
    revisionId: string,
  ): Promise<SubmissionRevision> {
    // §71: the lock is taken before the status is read, so validation and the
    // write it authorizes cannot be separated by another transaction.
    await tx.$queryRaw`
      SELECT "id" FROM "submission_revisions"
      WHERE "id" = ${revisionId}::uuid AND "organization_id" = ${organizationId}::uuid
      FOR UPDATE
    `;
    const revision = await tx.submissionRevision.findFirst({
      where: { id: revisionId, organizationId },
    });
    if (revision === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_REVISION_NOT_FOUND, {
        message: 'That submission revision does not exist.',
      });
    }
    return revision;
  }
}

/**
 * A submitter the disclosure function declined to name.
 *
 * Reached only if a row disappears between the two queries. Rendering the
 * queue without a name is right; failing the reviewer's whole queue is not.
 */
function unknownSubmitter(userId: string): SubmitterIdentityView {
  return { userId, displayName: null, email: '' };
}

export function organizationRevisionView(
  revision: SubmissionRevision,
  currentRevisionId: string | null,
): OrganizationSubmissionRevisionView {
  return {
    id: revision.id,
    submissionId: revision.submissionId,
    revisionNumber: revision.revisionNumber,
    institutionDecisionStatus: revision.institutionDecisionStatus as InstitutionDecisionStatus,
    documentFormat: revision.sourceDocumentFormat as DocumentFormat,
    documentSha256: revision.sourceDocumentSha256,
    reportHash: revision.sourceReportHash,
    evaluationHash: revision.sourceEvaluationHash,
    evidenceHash: revision.evidenceHash ?? '',
    standard: standardView(revision),
    technical: technicalView(revision),
    submittedAt: (revision.submittedAt ?? revision.createdAt).toISOString(),
    reviewStartedAt: revision.reviewStartedAt?.toISOString() ?? null,
    decidedAt: revision.decidedAt?.toISOString() ?? null,
    isCurrent: revision.id === currentRevisionId,
  };
}
