import { Injectable } from '@nestjs/common';
import { ProcessingJobType } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { CertificateEligibilityService } from './certificate-eligibility.service';
import { CertificateSchedulingService } from './certificate-scheduling.service';

/** How many outstanding approvals one sweep will pick up. */
const BATCH = 25;

/**
 * Finding eligible approvals that have no certificate (§77, §78, §79).
 *
 * Two quite different situations produce the same row, and both need the same
 * answer:
 *
 *  - An approval recorded before Phase 15 existed. Nobody is going to ask
 *    those reviewers to approve again, so PalCert has to notice them itself.
 *  - An approval whose scheduling was missed — a crash between commit and
 *    dispatch, or a job that exhausted its retries during an outage.
 *
 * It is strictly read-and-enqueue. It never edits a Phase 14 decision, never
 * "repairs" a determination, and never issues anything itself: it finds work
 * and hands it to the ordinary issuance path, which applies the same
 * eligibility rule the database enforces anyway.
 */
@Injectable()
export class CertificateReconciliationService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly eligibility: CertificateEligibilityService,
    private readonly scheduling: CertificateSchedulingService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CertificateReconciliationService.name);
  }

  /**
   * One sweep. Returns how many certificates it scheduled.
   *
   * Idempotent by construction: scheduling claims a certificate through the
   * unique-per-revision function, so a revision already claimed is a no-op and
   * two overlapping sweeps cannot produce two certificates.
   */
  async reconcile(): Promise<number> {
    // No tenant scope and no actor: this is PalCert's own housekeeping, and
    // the narrow system function is what lets it see across owners without
    // borrowing somebody's identity to do it. The function returns two
    // identifiers and nothing else, so an unscoped call discloses nothing.
    const outstanding = await this.eligibility.outstanding(this.prisma, BATCH);

    let scheduled = 0;
    for (const candidate of outstanding) {
      try {
        const certificateId = await this.tenant.withUser(candidate.ownerUserId, (tx) =>
          this.scheduling.schedule(tx, candidate.revisionId, candidate.ownerUserId),
        );
        if (certificateId === null) continue;

        const job = await this.jobs.findByResource(
          ProcessingJobType.CERTIFICATE_ISSUE,
          certificateId,
        );
        if (job !== null) await this.dispatcher.dispatchNow(job.id);
        scheduled += 1;
      } catch (error) {
        // One unschedulable revision must not stop the sweep: the usual cause
        // is that it stopped being eligible between the query and the claim,
        // which is not an error, and the next sweep will not see it again.
        this.logger.debug(
          { revisionId: candidate.revisionId, error: describe(error) },
          'certificate reconciliation skipped a revision',
        );
      }
    }

    if (scheduled > 0) {
      this.logger.info({ scheduled }, 'certificate reconciliation scheduled issuance');
    }
    return scheduled;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
