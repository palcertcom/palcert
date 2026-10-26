import { Injectable } from '@nestjs/common';
import { SmartFixFailureCode, SmartFixRequestStatus } from '@palcert/contracts';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import {
  SmartFixExecutionService,
  SmartFixFailure,
} from '../modules/smartfix/services/smartfix-execution.service';
import { SmartFixFinalizeService } from '../modules/smartfix/services/smartfix-finalize.service';
import { SmartFixSettlementService } from '../modules/smartfix/services/smartfix-settlement.service';
import { requireJobOwner } from './job-owner';

/**
 * `SMARTFIX_EXECUTE` and `SMARTFIX_FINALIZE` (Phase 12 §59).
 *
 * The split is what lets the recheck in the middle be an ordinary check, with
 * its own queue, its own retries and its own failures. Execute corrects the
 * document and hands over; finalize runs when the recheck finishes and decides
 * whether there is anything worth delivering.
 *
 * A failure the engine calls permanent releases the reservation *now* rather
 * than after the retry ladder: retrying a plan that does not match its
 * document would fail identically for ever while the customer's balance stayed
 * set aside (§80).
 */
@Injectable()
export class SmartFixJobHandler {
  constructor(
    private readonly execution: SmartFixExecutionService,
    private readonly finalize: SmartFixFinalizeService,
    private readonly settlement: SmartFixSettlementService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixJobHandler.name);
  }

  async execute(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) throw new Error(`smartfix job ${job.id} has no owner`);
    try {
      await this.execution.execute(owner, job.resourceId);
    } catch (error) {
      await this.settleOrRethrow(owner, job.resourceId, error);
    }
  }

  async finalizeJob(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) throw new Error(`smartfix job ${job.id} has no owner`);
    try {
      await this.finalize.finalize(owner, job.resourceId);
    } catch (error) {
      await this.settleOrRethrow(owner, job.resourceId, error);
    }
  }

  /**
   * The attempts are spent.
   *
   * Failing the correction is what gives the balance back: leaving it reserved
   * would keep somebody's money set aside for work that is not going to happen.
   */
  async failPermanently(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) return;
    await this.settlement.settle(owner, job.resourceId, {
      status: SmartFixRequestStatus.FAILED,
      code: SmartFixFailureCode.SERVICE_FAILED,
      detail: 'the correction could not be completed',
      allowedFrom: [
        SmartFixRequestStatus.RESERVED,
        SmartFixRequestStatus.PROCESSING,
        SmartFixRequestStatus.RECHECKING,
        SmartFixRequestStatus.VALIDATING,
      ],
    });
    this.logger.warn(
      { smartFixRequestId: job.resourceId },
      'SmartFix correction could not be completed; reservation released',
    );
  }

  private async settleOrRethrow(owner: string, requestId: string, error: unknown): Promise<void> {
    if (error instanceof SmartFixFailure && error.permanent) {
      await this.settlement.settle(owner, requestId, {
        status: SmartFixRequestStatus.FAILED,
        code: error.code,
        detail: error.detail,
        allowedFrom: [
          SmartFixRequestStatus.RESERVED,
          SmartFixRequestStatus.PROCESSING,
          SmartFixRequestStatus.RECHECKING,
          SmartFixRequestStatus.VALIDATING,
        ],
      });
      this.logger.warn(
        { smartFixRequestId: requestId, failureCode: error.code },
        'SmartFix correction refused; reservation released and nothing charged',
      );
      return;
    }
    // Transient. The retry ladder gets its turn, and `failPermanently` settles
    // it if the attempts run out.
    throw error;
  }
}
