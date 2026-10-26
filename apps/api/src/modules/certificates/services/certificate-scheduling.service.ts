import { Injectable } from '@nestjs/common';
import {
  ComplianceDetermination,
  InstitutionDecisionStatus,
  ProcessingJobType,
  SubmissionProcessingStatus,
  generateVerificationCode,
  verificationCodeHash,
} from '@palcert/contracts';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { sealVerificationCode } from '../../../common/crypto/verification-code-seal';
import { ApiConfigService } from '../../../config/api-config.service';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * Turning an eligible approval into durable work (§71–§76, and correction §3).
 *
 * The invariant this exists to guarantee:
 *
 *   once APPROVED + COMPLIANT is committed, either a certificate already
 *   exists or a durable CERTIFICATE_ISSUE intent does.
 *
 * Which is why scheduling happens *inside* the decision transaction rather
 * than after it. Committing the approval and then enqueueing separately looks
 * equivalent and is not: a crash between the two leaves an approved, compliant
 * submission that nothing will ever certify, and the person waiting for it has
 * no way to tell that from slow. Reconciliation would eventually find it, but
 * reconciliation is a safety net, not the mechanism.
 *
 * The reviewer still does not wait for any of this. The claim is not built,
 * the PDF is not rendered and storage is not touched here — only a row and a
 * job, both cheap, both in the transaction that was already open.
 */
@Injectable()
export class CertificateSchedulingService {
  constructor(
    private readonly jobs: ProcessingJobService,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CertificateSchedulingService.name);
  }

  /**
   * Claim a certificate for a revision, if it is eligible, and queue its work.
   *
   * Returns the certificate id when something was scheduled, or null when the
   * revision is not eligible — which is the ordinary case for most decisions
   * and is never an error.
   *
   * The eligibility rule is evaluated by the database function, not here: this
   * checks first only to avoid a pointless round trip on the overwhelmingly
   * common ineligible path.
   */
  async scheduleIfEligible(
    tx: TenantClient,
    revision: {
      readonly id: string;
      readonly ownerUserId: string;
      readonly processingStatus: string;
      readonly determination: string;
      readonly institutionDecisionStatus: string | null;
    },
  ): Promise<string | null> {
    if (
      revision.processingStatus !== SubmissionProcessingStatus.READY ||
      revision.determination !== ComplianceDetermination.COMPLIANT ||
      revision.institutionDecisionStatus !== InstitutionDecisionStatus.APPROVED
    ) {
      return null;
    }

    return this.schedule(tx, revision.id, revision.ownerUserId);
  }

  /**
   * Claim and queue, unconditionally asking the database to judge eligibility.
   *
   * Used by reconciliation, which has already filtered, and by the decision
   * path above. A revision the database refuses raises, and the caller treats
   * that as "not eligible" rather than as a failure — the two are the same
   * outcome from the product's point of view.
   */
  async schedule(
    tx: TenantClient,
    revisionId: string,
    ownerUserId: string,
  ): Promise<string | null> {
    // 160 bits, generated per certificate and never derived from anything
    // guessable.
    //
    // Two things reach the row and neither is a capability: a one-way digest,
    // which is what public verification looks up by, and the code sealed under
    // a key PostgreSQL does not hold, which exists only until the worker has
    // used it. The readable number is never a column at all — it lives in the
    // claim artifact, the PDF and the QR, which are the holder's copies.
    const code = generateVerificationCode();
    const certificateId = randomUUID();

    const claimed = await tx.$queryRaw<{ app_certificate_claim: string }[]>`
      SELECT app_certificate_claim(
        ${certificateId}::uuid,
        ${revisionId}::uuid,
        ${verificationCodeHash(code)}::text,
        ${sealVerificationCode(code, this.config.certificateVerificationKey)}::text
      )
    `;

    const id = claimed[0]?.app_certificate_claim ?? null;
    if (id === null) return null;

    // §76: the job's identity is the certificate, so ten deliveries converge
    // on one piece of work rather than ten.
    await this.jobs.enqueueInTransaction(tx, {
      type: ProcessingJobType.CERTIFICATE_ISSUE,
      resourceType: 'COMPLIANCE_CERTIFICATE',
      resourceId: id,
      ownerUserId,
    });

    return id;
  }
}
