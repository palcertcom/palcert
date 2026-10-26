import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ClockPort } from '../../auth/ports/clock.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

const SWEEP_LIMIT = 200;

/**
 * Wiping secret material whose recovery window has closed.
 *
 * This is storage hygiene and nothing more. The authorization decision is made
 * at read time by comparing the clock to `reveal_expires_at`, so a sweeper
 * that has not run for a week never makes an expired secret recoverable — the
 * read path refuses before anything is decrypted. All this does is stop the
 * ciphertext outliving its purpose in backups and exports.
 *
 * What it does not touch: the operation row, the expiry timestamp, and the
 * idempotency tombstone. Those stay for ever, so the same key can never
 * quietly produce a second side effect later.
 */
@Injectable()
export class WebhookRevealSweeper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookRevealSweeper.name);
  }

  async sweep(): Promise<number> {
    const expired = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT * FROM app_webhook_expired_reveals($1::timestamptz, $2::integer)`,
      this.clock.now(),
      SWEEP_LIMIT,
    );

    let cleared = 0;
    for (const operation of expired) {
      try {
        await this.prisma.$executeRawUnsafe(
          `SELECT app_webhook_reveal_clear($1::uuid)`,
          operation.id,
        );
        cleared += 1;
      } catch (error) {
        this.logger.warn(
          { err: error, operationId: operation.id },
          'could not clear an expired webhook reveal',
        );
      }
    }

    if (cleared > 0) {
      this.logger.info({ cleared }, 'cleared expired webhook secret reveals');
    }
    return cleared;
  }
}
