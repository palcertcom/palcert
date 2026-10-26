import { Injectable } from '@nestjs/common';
import { DocumentAuditAction, DocumentStatus } from '@palcert/contracts';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { requireJobOwner } from './job-owner';

/**
 * DOCUMENT_PURGE (§83, §84).
 *
 * Removes the objects of a soft-deleted document, version by version. A
 * version with a retention lock is skipped and the document stays partially
 * purged — a later phase's check, report, certificate or submission still
 * needs those bytes. A version is marked purged only after storage confirmed
 * the delete; a delete that fails throws, and the job is retried.
 */
@Injectable()
export class PurgeJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PurgeJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    const documentId = job.resourceId;

    const document = await this.tenant.withUser(owner, (tx) =>
      tx.document.findUnique({
        where: { id: documentId },
        include: {
          versions: {
            include: {
              retentionLocks: { select: { id: true } },
              // Phase 6 stored derived artifacts but nothing deleted them; a
              // purge that removed the source and left the facts behind would
              // be a deletion that did not delete (Phase 6 debt §121b).
              analyses: {
                select: { id: true, artifactObjectKey: true, artifactPurgedAt: true },
              },
            },
          },
        },
      }),
    );
    if (document === null || document.status !== DocumentStatus.DELETED) {
      this.logger.info({ jobId: job.id }, 'Nothing to purge');
      return;
    }

    let remaining = 0;
    for (const version of document.versions) {
      if (version.purgedAt !== null) continue;
      if (version.retentionLocks.length > 0) {
        remaining += 1;
        continue;
      }
      if (version.cleanObjectKey !== null) {
        await this.storage.deleteObject({ zone: 'clean', key: version.cleanObjectKey });
      }
      if (version.quarantineDeletedAt === null) {
        await this.storage.deleteObject({ zone: 'quarantine', key: version.quarantineObjectKey });
      }

      // The derived artifacts go with the source. Reaching here at all means
      // no retention lock is held, and a completed check always holds one, so
      // no artifact a historical report cites can be deleted here (§70, §71).
      for (const analysis of version.analyses) {
        if (analysis.artifactObjectKey === null || analysis.artifactPurgedAt !== null) continue;
        await this.storage.deleteObject({ zone: 'derived', key: analysis.artifactObjectKey });
      }
      const now = this.clock.now();
      await this.tenant.withUser(owner, (tx) =>
        tx.documentVersion.update({
          where: { id: version.id },
          data: { purgedAt: now, quarantineDeletedAt: version.quarantineDeletedAt ?? now },
        }),
      );
      // The analysis rows survive their artifacts: a report must still be able
      // to name the analyzer that produced its evidence (§71).
      await this.tenant.withUser(owner, (tx) =>
        tx.documentAnalysis.updateMany({
          where: { documentVersionId: version.id, artifactPurgedAt: null },
          data: { artifactPurgedAt: now },
        }),
      );
      await this.events.audit({
        action: DocumentAuditAction.DOCUMENT_VERSION_PURGED,
        actorUserId: null,
        targetType: 'DocumentVersion',
        targetId: version.id,
      });
    }

    if (remaining === 0) {
      await this.tenant.withUser(owner, (tx) =>
        tx.document.update({ where: { id: documentId }, data: { purgedAt: this.clock.now() } }),
      );
    } else {
      this.logger.info(
        { documentId, remaining },
        'Versions retained by locks; document not fully purged',
      );
    }
  }
}
