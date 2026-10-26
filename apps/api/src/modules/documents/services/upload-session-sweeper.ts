import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DocumentAuditAction } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';

interface ExpiredRow {
  session_id: string;
  document_version_id: string;
  owner_user_id: string;
  storage_key: string;
}

/**
 * Expires abandoned uploads (§28).
 *
 * Runs without a user context through one SECURITY DEFINER function that
 * does only this. The staged objects are then deleted; a delete that fails
 * is logged and left to the bucket lifecycle rule, which is the second line
 * of defence against quarantine filling with abandoned bytes.
 */
@Injectable()
export class UploadSessionSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UploadSessionSweeper.name);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.config.upload.sweepIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    let expired: ExpiredRow[];
    try {
      expired = await this.prisma.$queryRaw<ExpiredRow[]>`
        SELECT * FROM app_expire_upload_sessions((${this.clock.now()}::timestamptz AT TIME ZONE 'UTC')::timestamp(3), 100)
      `;
    } catch (error) {
      this.logger.warn({ err: error }, 'Upload session sweep failed');
      return 0;
    }

    for (const row of expired) {
      await this.events.audit({
        action: DocumentAuditAction.UPLOAD_SESSION_EXPIRED,
        actorUserId: null,
        targetType: 'DocumentVersion',
        targetId: row.document_version_id,
      });
      try {
        await this.storage.deleteObject({ zone: 'quarantine', key: row.storage_key });
      } catch (error) {
        this.logger.warn(
          { err: error, versionId: row.document_version_id },
          'Staged object not removed; lifecycle rule will expire it',
        );
      }
    }
    return expired.length;
  }
}
