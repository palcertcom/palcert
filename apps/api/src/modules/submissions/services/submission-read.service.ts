import { Injectable } from '@nestjs/common';
import {
  AppError,
  InstitutionDecisionStatus,
  NOT_SUBMITTED,
  PalCertErrorCode,
  SUBMISSION_NOT_SHARED_ITEMS,
  SUBMISSION_SHARED_ITEMS,
  SubmissionProcessingStatus,
  isPermanentSubmissionFailure,
  type ComplianceDetermination,
  type DocumentFormat,
  type OfficialSubmissionView,
  type SubmissionCommentView,
  type SubmissionDecisionEventView,
  type SubmissionDisclosureView,
  type SubmissionEventSource,
  type SubmissionFailureCode,
  type SubmissionRevisionView,
  type SubmissionStandardView,
  type SubmissionTechnicalSummaryView,
  type SubmitterIdentityView,
} from '@palcert/contracts';
import type { OfficialSubmission, SubmissionRevision } from '@palcert/database';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { SubmissionEligibilityService } from './submission-eligibility.service';

/**
 * Everything the author may read about their own submissions (§88).
 *
 * The author's side is the permissive one: it is their document, their check
 * and their report, and the submission is a thing they did. So this service
 * answers freely — but only ever under `withUser`, so the row-level policies
 * are the floor under every query rather than a filter this code remembers to
 * add.
 */
@Injectable()
export class SubmissionReadService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly eligibility: SubmissionEligibilityService,
  ) {}

  /**
   * What submitting this check would hand over, before it is handed over
   * (§21, §86).
   *
   * Generated from the same eligibility read the submission itself uses, so
   * the promise and the act cannot drift: if this cannot be produced, the
   * submission would not have been accepted either.
   */
  async disclosure(userId: string, checkId: string): Promise<SubmissionDisclosureView> {
    const check = await this.eligibility.submittableCheck(userId, checkId);
    await this.eligibility.assertOrganizationEligible(check.organizationId);

    const submitter = await this.submitter(userId, userId);

    return {
      organizationId: check.organizationId,
      organizationName: check.organizationName,
      documentTypeName: check.documentTypeName,
      documentVersionNumber: check.documentVersionNumber,
      documentFormat: check.documentFormat as DocumentFormat,
      standard: {
        standardId: check.standardId,
        standardVersionId: check.standardVersionId,
        standardCode: check.standardCode,
        standardName: check.standardName,
        standardVersionLabel: check.standardVersionLabel,
        standardContentHash: check.standardContentHash,
      },
      technical: {
        determination: check.determination as ComplianceDetermination,
        score: check.scoreValue,
        scoreCoverage: check.scoreCoverage,
        scoreComplete: check.scoreComplete,
        totalRules: check.totalRules,
        passedRules: check.passedRules,
        failedRules: check.failedRules,
        reviewRequiredRules: check.reviewRequiredRules,
        indeterminateRules: check.indeterminateRules,
        notApplicableRules: check.notApplicableRules,
      },
      submitter,
      shared: SUBMISSION_SHARED_ITEMS,
      notShared: SUBMISSION_NOT_SHARED_ITEMS,
    };
  }

  /** The author's own cases, newest first. */
  async list(userId: string): Promise<OfficialSubmissionView[]> {
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.officialSubmission.findMany({
        where: { ownerUserId: userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { revisions: { orderBy: { revisionNumber: 'desc' } }, document: true },
      }),
    );
    return rows.map((row) => this.caseView(row, row.revisions, row.document.displayName));
  }

  /** One case of the author's own. */
  async get(userId: string, submissionId: string): Promise<OfficialSubmissionView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.officialSubmission.findFirst({
        where: { id: submissionId, ownerUserId: userId },
        include: { revisions: { orderBy: { revisionNumber: 'desc' } }, document: true },
      }),
    );
    // §90: another person's submission id is not found, never forbidden. The
    // difference would confirm the id exists.
    if (row === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_NOT_FOUND, {
        message: 'That submission does not exist.',
      });
    }
    return this.caseView(row, row.revisions, row.document.displayName);
  }

  /** The institution's decision history on one of the author's revisions. */
  async history(userId: string, revisionId: string): Promise<SubmissionDecisionEventView[]> {
    const revision = await this.ownRevision(userId, revisionId);
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.submissionDecisionEvent.findMany({
        where: { submissionRevisionId: revision.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map(eventView);
  }

  /** The institution's comments on one of the author's revisions (§67). */
  async comments(userId: string, revisionId: string): Promise<SubmissionCommentView[]> {
    const revision = await this.ownRevision(userId, revisionId);
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.submissionComment.findMany({
        where: { submissionRevisionId: revision.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map(commentView);
  }

  /** A revision the caller really owns, or a 404 that says nothing else. */
  async ownRevision(userId: string, revisionId: string): Promise<SubmissionRevision> {
    const revision = await this.tenant.withUser(userId, (tx) =>
      tx.submissionRevision.findFirst({ where: { id: revisionId, ownerUserId: userId } }),
    );
    if (revision === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_REVISION_NOT_FOUND, {
        message: 'That submission revision does not exist.',
      });
    }
    return revision;
  }

  /**
   * Display name and email, and nothing else (§85, §87).
   *
   * Read under the *reader's* scope, so an organization asking about a
   * submitter reads exactly the columns named here and no row the policies
   * would not have given them anyway.
   */
  async submitter(readerUserId: string, submitterUserId: string): Promise<SubmitterIdentityView> {
    const user = await this.tenant.withUser(readerUserId, (tx) =>
      tx.user.findUnique({
        where: { id: submitterUserId },
        select: { id: true, displayName: true, email: true },
      }),
    );
    if (user === null) {
      return { userId: submitterUserId, displayName: null, email: '' };
    }
    return { userId: user.id, displayName: user.displayName, email: user.email };
  }

  private caseView(
    submission: OfficialSubmission,
    revisions: readonly SubmissionRevision[],
    documentName: string,
  ): OfficialSubmissionView {
    const current =
      submission.currentRevisionId === null
        ? null
        : (revisions.find((revision) => revision.id === submission.currentRevisionId) ?? null);

    return {
      id: submission.id,
      organizationId: submission.organizationId,
      organizationName: submission.organizationName,
      documentTypeId: submission.documentTypeId,
      documentTypeName: submission.documentTypeName,
      documentId: submission.documentId,
      documentName,
      currentRevision: current === null ? null : revisionView(current),
      revisionCount: revisions.length,
      // §4: derived, never stored. No revision has reached an institution, so
      // the case has no institution status at all.
      displayStatus:
        current?.institutionDecisionStatus === undefined ||
        current.institutionDecisionStatus === null
          ? NOT_SUBMITTED
          : (current.institutionDecisionStatus as InstitutionDecisionStatus),
      createdAt: submission.createdAt.toISOString(),
      updatedAt: submission.updatedAt.toISOString(),
    };
  }
}

export function standardView(revision: SubmissionRevision): SubmissionStandardView {
  return {
    standardId: revision.standardId,
    standardVersionId: revision.standardVersionId,
    standardCode: revision.standardCode,
    standardName: revision.standardName,
    standardVersionLabel: revision.standardVersionLabel,
    standardContentHash: revision.standardContentHash,
  };
}

export function technicalView(revision: SubmissionRevision): SubmissionTechnicalSummaryView {
  return {
    determination: revision.determination as ComplianceDetermination,
    score: revision.scoreValue,
    scoreCoverage: revision.scoreCoverage,
    scoreComplete: revision.scoreComplete,
    totalRules: revision.totalRules,
    passedRules: revision.passedRules,
    failedRules: revision.failedRules,
    reviewRequiredRules: revision.reviewRequiredRules,
    indeterminateRules: revision.indeterminateRules,
    notApplicableRules: revision.notApplicableRules,
  };
}

export function revisionView(revision: SubmissionRevision): SubmissionRevisionView {
  const failureCode = revision.failureCode as SubmissionFailureCode | null;
  return {
    id: revision.id,
    submissionId: revision.submissionId,
    revisionNumber: revision.revisionNumber,
    processingStatus: revision.processingStatus as SubmissionProcessingStatus,
    failureCode,
    // §37: a transient storage failure may be attempted again; a mismatched
    // digest may not, because retrying would not make the bytes agree.
    retryable:
      revision.processingStatus === SubmissionProcessingStatus.FAILED &&
      failureCode !== null &&
      !isPermanentSubmissionFailure(failureCode),
    institutionDecisionStatus:
      revision.institutionDecisionStatus as InstitutionDecisionStatus | null,
    documentVersionId: revision.sourceDocumentVersionId,
    documentVersionNumber: revision.documentVersionNumber,
    documentSha256: revision.sourceDocumentSha256,
    documentFormat: revision.sourceDocumentFormat as DocumentFormat,
    checkId: revision.sourceCheckId,
    reportId: revision.sourceReportId,
    reportHash: revision.sourceReportHash,
    evaluationHash: revision.sourceEvaluationHash,
    standard: standardView(revision),
    technical: technicalView(revision),
    evidenceHash: revision.evidenceHash,
    createdAt: revision.createdAt.toISOString(),
    submittedAt: revision.submittedAt?.toISOString() ?? null,
    reviewStartedAt: revision.reviewStartedAt?.toISOString() ?? null,
    decidedAt: revision.decidedAt?.toISOString() ?? null,
  };
}

export function eventView(row: {
  id: string;
  submissionRevisionId: string;
  eventSource: string;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string | null;
  actorUserId: string | null;
  createdAt: Date;
}): SubmissionDecisionEventView {
  return {
    id: row.id,
    submissionRevisionId: row.submissionRevisionId,
    eventSource: row.eventSource as SubmissionEventSource,
    fromStatus: row.fromStatus as InstitutionDecisionStatus | null,
    toStatus: row.toStatus as InstitutionDecisionStatus,
    reasonCode: row.reasonCode as SubmissionDecisionEventView['reasonCode'],
    actorUserId: row.actorUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function commentView(row: {
  id: string;
  submissionRevisionId: string;
  authorSide: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
}): SubmissionCommentView {
  return {
    id: row.id,
    submissionRevisionId: row.submissionRevisionId,
    authorSide: row.authorSide as SubmissionCommentView['authorSide'],
    authorUserId: row.authorUserId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
