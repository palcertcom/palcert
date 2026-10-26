import { Injectable } from '@nestjs/common';
import {
  CertificateIneligibilityReason,
  ComplianceDetermination,
  InstitutionDecisionStatus,
  SubmissionProcessingStatus,
} from '@palcert/contracts';
import type { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * Whether a submission may become a certificate (§4, §5, §6, §7).
 *
 * One predicate, stated once. The database enforces it again when the
 * certificate row is created — this exists so the product can *explain* an
 * answer, not so it can decide one. If these two ever disagree, the database
 * wins and nothing is issued.
 *
 * The rule is deliberately unforgiving. `NON_COMPLIANT + APPROVED` is a
 * perfectly legitimate Phase 14 outcome and produces no certificate;
 * `COMPLIANT + REJECTED` likewise. A certificate means both authorities agreed,
 * and there is no partial credit.
 */
export interface EligibilityVerdict {
  readonly eligible: boolean;
  readonly reason: CertificateIneligibilityReason | null;
}

export const ELIGIBLE: EligibilityVerdict = { eligible: true, reason: null };

@Injectable()
export class CertificateEligibilityService {
  /**
   * Judge one revision, given the case it belongs to.
   *
   * Ordered so the answer a person sees is the most useful true one: a
   * superseded revision is told it was superseded, not that it was never
   * approved.
   */
  verdict(params: {
    readonly processingStatus: string;
    readonly determination: string;
    readonly institutionDecisionStatus: string | null;
    readonly revisionId: string;
    readonly currentRevisionId: string | null;
  }): EligibilityVerdict {
    if (params.processingStatus !== SubmissionProcessingStatus.READY) {
      return { eligible: false, reason: CertificateIneligibilityReason.NOT_HANDED_OVER };
    }
    if (params.currentRevisionId !== params.revisionId) {
      return { eligible: false, reason: CertificateIneligibilityReason.SUPERSEDED_REVISION };
    }

    const decision = params.institutionDecisionStatus;
    if (
      decision === null ||
      decision === InstitutionDecisionStatus.SUBMITTED ||
      decision === InstitutionDecisionStatus.UNDER_REVIEW ||
      decision === InstitutionDecisionStatus.REVISION_REQUESTED
    ) {
      return {
        eligible: false,
        reason: CertificateIneligibilityReason.AWAITING_INSTITUTION_DECISION,
      };
    }
    if (decision !== InstitutionDecisionStatus.APPROVED) {
      // REJECTED. Said plainly, because the alternative — implying PalCert's
      // result was the problem — would misdescribe what the institution did.
      return { eligible: false, reason: CertificateIneligibilityReason.NOT_APPROVED };
    }

    // Approved, and still not certifiable unless PalCert measured it compliant.
    // §139: this is the case the phase exists to get right.
    if (params.determination !== ComplianceDetermination.COMPLIANT) {
      return { eligible: false, reason: CertificateIneligibilityReason.NOT_COMPLIANT };
    }

    return ELIGIBLE;
  }

  /**
   * Every revision that should have a certificate and does not (§78).
   *
   * Read-only and enqueue-only: reconciliation never edits a Phase 14 decision
   * and never "repairs" a determination (§79). It exists because scheduling at
   * approval time can be missed — by a deployment, by a crash, or by the
   * approval predating Phase 15 entirely (§77) — and a certificate that
   * silently never arrives is worse than one that arrives late.
   *
   * Goes through a narrow system function because the sweep must see across
   * every owner, and there is no person whose scope it could borrow.
   */
  async outstanding(
    tx: TenantClient | PrismaService,
    limit: number,
  ): Promise<{ revisionId: string; ownerUserId: string }[]> {
    const rows = await tx.$queryRaw<{ revision_id: string; owner_user_id: string }[]>`
      SELECT * FROM app_certificate_outstanding(${limit}::integer)
    `;
    return rows.map((row) => ({ revisionId: row.revision_id, ownerUserId: row.owner_user_id }));
  }
}
