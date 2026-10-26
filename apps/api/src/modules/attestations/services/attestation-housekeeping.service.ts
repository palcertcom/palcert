import { Injectable } from '@nestjs/common';
import {
  AttestationArtifactStatus,
  AttestationPaymentStatus,
  AttestationRequestStatus,
  ProcessingJobType,
  dueReminderStage,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import { SYSTEM_ACTOR } from '../attestation-support';

const BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PalCert's own recurring attestation work (§14, §45, §48).
 *
 * Three jobs, each idempotent on its own and each bounded per pass:
 *
 *   1. Expiry reminders. For every unrevoked attestation with an expiry, the
 *      due stage is computed from the attestation's own reminder schedule and
 *      recorded as a row whose (attestation, stage) is unique, *then* the
 *      notification is emitted from that row. A retried pass, two workers at
 *      once, or a replayed job all hit the unique key and emit nothing new.
 *      Instants are UTC and `validUntil` is valid-through, so there is no
 *      calendar day to be off by one in a user's timezone.
 *   2. Upload sessions that lapsed without bytes become UPLOAD_EXPIRED.
 *   3. Retention: the clean copy of a certificate that was never attested —
 *      a rejected or cancelled request, or a file that was replaced — is
 *      deleted after the configured period. An attested artifact is never
 *      touched: the database refuses to mark one purged.
 */
@Injectable()
export class AttestationHousekeepingService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly domainEvents: DomainEventService,
    private readonly storage: ObjectStoragePort,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttestationHousekeepingService.name);
  }

  async sweep(): Promise<{
    reminders: number;
    expiredUploads: number;
    purged: number;
    paymentsRevived: number;
  }> {
    let reminders = 0;
    let paymentsRevived = 0;
    let expiredUploads = 0;
    let purged = 0;
    try {
      reminders = await this.sendDueReminders();
    } catch (error) {
      this.logger.error({ err: error }, 'Attestation reminder pass failed');
    }
    try {
      expiredUploads = await this.expireUploads();
    } catch (error) {
      this.logger.error({ err: error }, 'Attestation upload expiry pass failed');
    }
    try {
      purged = await this.purgeUnattested();
    } catch (error) {
      this.logger.error({ err: error }, 'Attestation retention pass failed');
    }
    try {
      paymentsRevived = await this.reviveStrandedPayments();
    } catch (error) {
      this.logger.error({ err: error }, 'Attestation payment reconciliation pass failed');
    }
    return { reminders, expiredUploads, purged, paymentsRevived };
  }

  /**
   * A decided request whose money has not moved.
   *
   * The decision enqueued the payment job in its own commit, so this is only
   * reachable if that job ran out of attempts. Re-enqueueing revives the same
   * job rather than creating a second one, and the settlement it runs is
   * idempotent — so a reconciler that fires twice still settles once.
   */
  async reviveStrandedPayments(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 5 * 60 * 1000);
    const stranded = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'find decided attestation requests with unmoved fees' },
      (tx) =>
        tx.attestationRequest.findMany({
          where: {
            paymentStatus: AttestationPaymentStatus.RESERVED,
            status: { in: [AttestationRequestStatus.APPROVED, AttestationRequestStatus.REJECTED] },
            decidedAt: { lte: cutoff },
          },
          select: { id: true },
          take: BATCH,
        }),
    );
    let revived = 0;
    for (const request of stranded) {
      const job = await this.tenant.withPlatformAdmin(
        { actorUserId: SYSTEM_ACTOR, reason: 're-enqueue an attestation payment job' },
        (tx) =>
          this.jobs.enqueueInTransaction(tx, {
            type: ProcessingJobType.ATTESTATION_PAYMENT,
            resourceType: 'ATTESTATION_REQUEST',
            resourceId: request.id,
          }),
      );
      await this.dispatcher.dispatchNow(job.id);
      revived += 1;
    }
    return revived;
  }

  /** Record and announce every reminder stage that is due now. */
  async sendDueReminders(): Promise<number> {
    const now = this.clock.now();
    // The widest window any schedule can have is a year; nothing earlier can
    // be due, so the scan is bounded to attestations that could qualify.
    const horizon = new Date(now.getTime() + 366 * DAY_MS);
    const candidates = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'find attestations with due expiry reminders' },
      (tx) =>
        tx.attestation.findMany({
          where: {
            revokedAt: null,
            validUntil: { not: null, lte: horizon },
            // Anything that has already had its expiry notice is finished.
            NOT: { reminders: { some: { stage: 0 } } },
          },
          select: {
            id: true,
            validUntil: true,
            reminderDays: true,
            reminders: { select: { stage: true } },
          },
          orderBy: { validUntil: 'asc' },
          take: BATCH,
        }),
    );

    let sent = 0;
    for (const candidate of candidates) {
      const stage = dueReminderStage({
        validUntil: candidate.validUntil!,
        now,
        scheduleDays: candidate.reminderDays,
        alreadySent: candidate.reminders.map((reminder) => reminder.stage),
      });
      if (stage === null) continue;
      try {
        const recorded = await this.recordReminder(candidate.id, stage, now);
        if (recorded) sent += 1;
      } catch (error) {
        // One failure must not stop the pass for everyone else.
        this.logger.warn(
          { err: error, attestationId: candidate.id, stage },
          'Could not record reminder',
        );
      }
    }
    return sent;
  }

  private async recordReminder(attestationId: string, stage: number, now: Date): Promise<boolean> {
    return this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'record an attestation expiry reminder' },
      async (tx) => {
        const attestation = await tx.attestation.findUnique({ where: { id: attestationId } });
        if (attestation === null || attestation.revokedAt !== null) return false;
        const inserted = await tx.attestationReminder.createMany({
          data: [
            {
              attestationId,
              requestId: attestation.requestId,
              ownerUserId: attestation.ownerUserId,
              organizationId: attestation.organizationId,
              stage,
              recordedAt: now,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) return false;
        const reminder = await tx.attestationReminder.findUniqueOrThrow({
          where: { attestationId_stage: { attestationId, stage } },
        });
        await this.domainEvents.emitAttestationReminder(tx, reminder.id);
        if (stage === 0) {
          await this.events.auditWithin(tx, {
            action: 'ATTESTATION_EXPIRED',
            actor: { type: 'SYSTEM' },
            targetType: 'Attestation',
            targetId: attestationId,
            afterState: {
              organizationId: attestation.organizationId,
              reference: attestation.reference,
              validUntil: attestation.validUntil?.toISOString() ?? null,
            },
          });
        }
        return true;
      },
    );
  }

  async expireUploads(): Promise<number> {
    const now = this.clock.now();
    const result = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'expire lapsed attestation upload sessions' },
      (tx) =>
        tx.attestationArtifact.updateMany({
          where: {
            status: AttestationArtifactStatus.AWAITING_UPLOAD,
            uploadExpiresAt: { lte: now },
          },
          data: { status: AttestationArtifactStatus.UPLOAD_EXPIRED, updatedAt: now },
        }),
    );
    return result.count;
  }

  async purgeUnattested(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(
      now.getTime() - this.config.attestations.unattestedArtifactRetentionDays * DAY_MS,
    );
    const due = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'find unattested attestation artifacts past retention' },
      (tx) =>
        tx.attestationArtifact.findMany({
          where: {
            status: AttestationArtifactStatus.READY,
            purgedAt: null,
            cleanObjectKey: { not: null },
            updatedAt: { lte: cutoff },
            OR: [
              // The request ended without an attestation.
              {
                request: {
                  status: {
                    in: [AttestationRequestStatus.REJECTED, AttestationRequestStatus.CANCELLED],
                  },
                  updatedAt: { lte: cutoff },
                },
              },
              // Or the request moved on to another file, and ended.
              {
                request: {
                  status: {
                    in: [
                      AttestationRequestStatus.APPROVED,
                      AttestationRequestStatus.REJECTED,
                      AttestationRequestStatus.CANCELLED,
                    ],
                  },
                  updatedAt: { lte: cutoff },
                  attestation: { isNot: null },
                },
              },
            ],
          },
          select: {
            id: true,
            cleanObjectKey: true,
            request: { select: { attestation: { select: { artifactId: true } } } },
          },
          take: BATCH,
        }),
    );

    let purged = 0;
    for (const artifact of due) {
      // Never the attested file, whatever the query above matched.
      if (artifact.request.attestation?.artifactId === artifact.id) continue;
      try {
        await this.storage.deleteObject({ zone: 'clean', key: artifact.cleanObjectKey! });
        await this.tenant.withPlatformAdmin(
          { actorUserId: SYSTEM_ACTOR, reason: 'record an attestation artifact purge' },
          (tx) =>
            tx.attestationArtifact.updateMany({
              where: { id: artifact.id, purgedAt: null },
              data: { purgedAt: now, updatedAt: now },
            }),
        );
        purged += 1;
      } catch (error) {
        this.logger.warn(
          { err: error, artifactId: artifact.id },
          'Could not purge attestation artifact',
        );
      }
    }
    return purged;
  }
}
