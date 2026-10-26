import { Injectable } from '@nestjs/common';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { DocumentCheckService } from '../modules/checks/services/document-check.service';
import { PaidCheckSettlementService } from '../modules/checks/services/paid-check-settlement.service';
import { requireJobOwner } from './job-owner';

/**
 * Getting one paid check moving (§23, §24).
 *
 * This handler exists to close a gap Phase 7 left open and Phase 11 cannot
 * afford. Phase 7 committed the check and *then*, in the same HTTP request,
 * made sure an analysis existed and queued the evaluation. If the API process
 * died in between, the check simply sat there — annoying, and free.
 *
 * Once the customer's credit is reserved, the same gap means money set aside
 * for work nobody ever started. So the intent to prepare is written inside the
 * commercial transaction, and this is what consumes it: whatever happens to
 * the API process after the commit, the work still begins.
 *
 * Every step it drives is idempotent, because at-least-once delivery means it
 * will sometimes run twice (§24, §82).
 */
@Injectable()
export class CheckPrepareJobHandler {
  constructor(
    private readonly checks: DocumentCheckService,
    private readonly settlement: PaidCheckSettlementService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CheckPrepareJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) throw new Error(`check prepare job ${job.id} has no owner`);
    await this.checks.prepare(owner, job.resourceId);
  }

  /**
   * The attempts are spent and the check never started.
   *
   * Failing it is what releases the reservation: leaving the purchase
   * reserved would keep the customer's money set aside for work that is not
   * going to happen (§37).
   */
  async failPermanently(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) return;
    await this.settlement.fail(owner, job.resourceId, {
      code: 'CHECK_PREPARE_FAILED',
      detail: 'the check could not be started',
    });
    this.logger.warn({ checkId: job.resourceId }, 'Paid check could not be started; released');
  }
}
