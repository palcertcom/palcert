import { Injectable } from '@nestjs/common';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { AttestationPaymentService } from '../modules/attestations/services/attestation-payment.service';

/**
 * ATTESTATION_PAYMENT: move the money an institution's decision implied.
 *
 * Enqueued in the decision's own transaction, so it exists exactly when a
 * decision committed. Idempotent: a request already settled or released is a
 * no-op, which is what makes an at-least-once queue safe here.
 */
@Injectable()
export class AttestationPaymentJobHandler {
  constructor(
    private readonly payments: AttestationPaymentService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttestationPaymentJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const outcome = await this.payments.settle(job.resourceId);
    this.logger.info(
      { jobId: job.id, requestId: job.resourceId, outcome },
      'Attestation payment job',
    );
  }
}
