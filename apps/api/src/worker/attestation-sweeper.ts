import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { AttestationHousekeepingService } from '../modules/attestations/services/attestation-housekeeping.service';

/**
 * Runs attestation housekeeping on the worker's sweep cadence: expiry
 * reminders, lapsed uploads, retention and stranded settlements. Every step
 * is idempotent, so two workers sweeping at once record each thing once.
 */
@Injectable()
export class AttestationSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly housekeeping: AttestationHousekeepingService,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttestationSweeper.name);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.config.upload.sweepIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const outcome = await this.housekeeping.sweep();
      if (Object.values(outcome).some((count) => count > 0)) {
        this.logger.info(outcome, 'Attestation housekeeping completed');
      }
    } finally {
      this.running = false;
    }
  }
}
