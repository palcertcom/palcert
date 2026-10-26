import { Injectable } from '@nestjs/common';
import { AppError, CheckStatus, DocumentStatus, PalCertErrorCode } from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * What the evidence has to be before PalCert will hand it to an institution
 * (§144).
 *
 * Everything here is verified against the author's own private rows, under the
 * author's own scope. The organization is not consulted and learns nothing:
 * until the submission exists, there is nothing for it to learn.
 *
 * The checks are deliberately strict about identity and deliberately silent
 * about quality. A NON_COMPLIANT thesis may be submitted, and so may an
 * INDETERMINATE one — the institution decides what to do with it, which is the
 * whole point of keeping the two authorities apart (§14). What must hold is
 * that the bytes, the rules and the report really are the ones the check
 * measured.
 */
export interface SubmittableCheck {
  readonly checkId: string;
  readonly checkRunId: string;
  readonly reportId: string;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly reportArtifactKey: string;
  readonly reportArtifactVersionId: string | null;
  readonly reportArtifactSha256: string;

  readonly documentId: string;
  readonly documentName: string;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  readonly documentSha256: string;
  readonly documentFormat: string;
  readonly cleanObjectKey: string;
  readonly cleanObjectVersionId: string | null;

  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly standardId: string;
  readonly standardVersionId: string;
  readonly standardContentHash: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;

  readonly determination: string;
  readonly scoreValue: string | null;
  readonly scoreCoverage: string | null;
  readonly scoreComplete: boolean;
  readonly totalRules: number;
  readonly passedRules: number;
  readonly failedRules: number;
  readonly reviewRequiredRules: number;
  readonly indeterminateRules: number;
  readonly notApplicableRules: number;
}

@Injectable()
export class SubmissionEligibilityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Load a check the caller may hand over, or say precisely why they may not.
   *
   * Read under the caller's own row-level security context, so another user's
   * check is not merely filtered out — it is invisible to the connection, and
   * the answer is the same 404 a nonexistent id gets.
   */
  async submittableCheck(userId: string, checkId: string): Promise<SubmittableCheck> {
    const rows = await this.tenant.withUser(userId, async (tx) => {
      const check = await tx.documentCheck.findUnique({
        where: { id: checkId },
        include: {
          document: true,
          documentVersion: true,
          runs: { where: { status: 'SUCCEEDED' }, orderBy: { attemptNumber: 'desc' }, take: 1 },
          reports: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      return check;
    });

    if (rows === null) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
    }
    if (rows.status !== CheckStatus.COMPLETED) {
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_NOT_COMPLETED, {
        message: 'Only a completed check can be submitted officially.',
        details: { status: rows.status },
      });
    }

    const run = rows.runs[0];
    const report = rows.reports[0];
    if (run === undefined || report === undefined) {
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_NOT_COMPLETED, {
        message: 'This check has no completed technical report to submit.',
      });
    }
    if (report.checkRunId !== run.id) {
      // The report must be the report *of that run*. Anything else would hand
      // over a result and a document that were never measured together.
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_NOT_COMPLETED, {
        message: 'This check has no completed technical report to submit.',
        internalContext: { checkId, runId: run.id, reportRunId: report.checkRunId },
      });
    }

    if (rows.document.status === DocumentStatus.DELETED) {
      throw new AppError(PalCertErrorCode.DOCUMENT_DELETED, {
        message: 'That document has been deleted.',
      });
    }

    const version = rows.documentVersion;
    if (version.cleanObjectKey === null || version.sha256 === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_NOT_COMPLETED, {
        message: 'The checked document version is not available to submit.',
        internalContext: { versionId: version.id, reason: 'missing clean identity' },
      });
    }
    // §144: the document the check measured must still be the document on
    // disk. A version whose digest has moved is not evidence any more.
    if (version.sha256 !== rows.documentSha256) {
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_NOT_COMPLETED, {
        message: 'The checked document no longer matches what the check recorded.',
        internalContext: { versionId: version.id },
      });
    }

    if (run.determination === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_CHECK_NOT_COMPLETED, {
        message: 'This check produced no technical determination.',
      });
    }

    return {
      checkId: rows.id,
      checkRunId: run.id,
      reportId: report.id,
      reportHash: report.reportHash,
      evaluationHash: report.evaluationHash,
      reportArtifactKey: report.artifactObjectKey,
      reportArtifactVersionId: report.artifactObjectVersionId,
      reportArtifactSha256: report.artifactSha256,

      documentId: rows.documentId,
      documentName: rows.document.displayName,
      documentVersionId: version.id,
      documentVersionNumber: version.versionNumber,
      documentSha256: version.sha256,
      documentFormat: version.detectedFormat ?? 'DOCX',
      cleanObjectKey: version.cleanObjectKey,
      cleanObjectVersionId: version.cleanObjectVersionId,

      organizationId: rows.organizationId,
      organizationName: rows.organizationName,
      documentTypeId: rows.documentTypeId,
      documentTypeName: rows.documentTypeName,
      standardId: rows.standardId,
      standardVersionId: rows.standardVersionId,
      standardContentHash: rows.standardContentHash,
      standardCode: rows.standardCode,
      standardName: rows.standardName,
      standardVersionLabel: rows.standardVersionLabel,

      determination: run.determination,
      scoreValue: run.scoreValue,
      scoreCoverage: run.scoreCoverage,
      scoreComplete: run.scoreComplete ?? false,
      totalRules: run.totalRules ?? 0,
      passedRules: run.passedRules ?? 0,
      failedRules: run.failedRules ?? 0,
      reviewRequiredRules: run.reviewRequiredRules ?? 0,
      indeterminateRules: run.indeterminateRules ?? 0,
      notApplicableRules: run.notApplicableRules ?? 0,
    };
  }

  /**
   * Whether the organization may receive a new submission right now (§18).
   *
   * Fail-closed and deliberately narrow: ACTIVE and VERIFIED, and nothing
   * about the standard. §19 is explicit that a standard made private after the
   * author legitimately checked against it does not invalidate the evidence —
   * the author did nothing wrong, and refusing them would punish them for the
   * institution's later decision.
   *
   * Read through the platform connection rather than a tenant one, because the
   * submitter is not a member of the organization and must not need to be
   * (§17). It reads two public status columns and nothing else.
   */
  async assertOrganizationEligible(organizationId: string): Promise<void> {
    // §17, §18: the submitter is very often not a member, so `organizations`
    // cannot be read directly — its SELECT policy shows a row only to its own
    // members, and widening that to answer this question would disclose far
    // more than the question asks. The narrow disclosure function returns one
    // boolean and fails closed.
    const rows = await this.prisma.$queryRaw<{ eligible: boolean }[]>`
      SELECT app_submission_organization_eligible(${organizationId}::uuid) AS eligible
    `;
    if (rows[0]?.eligible !== true) {
      throw new AppError(PalCertErrorCode.SUBMISSION_ORGANIZATION_NOT_ELIGIBLE, {
        message: 'This organization is not currently accepting official submissions.',
      });
    }
  }

  /** The case a revision would join, if one exists. */
  async findCase(
    tx: TenantClient,
    params: { ownerUserId: string; organizationId: string; documentId: string },
  ) {
    return tx.officialSubmission.findFirst({
      where: {
        ownerUserId: params.ownerUserId,
        organizationId: params.organizationId,
        documentId: params.documentId,
      },
    });
  }
}
