import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  ProcessingJobType,
  assertSafeEventPayload,
  isNotificationType,
  type NotificationType,
} from '@palcert/contracts';
import type { DomainEvent } from '@palcert/database';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * Turning an authoritative row into an event, inside the transaction that
 * created it (§13, §15).
 *
 * Every method takes the caller's transaction and one authoritative row id.
 * The business change, the event and the fan-out job therefore commit
 * together or not at all: there is no window in which a submission is
 * approved and nothing is going to say so, and none in which something says
 * so and the approval rolled back.
 *
 * The emitters themselves are SQL functions. That is not an implementation
 * detail: it means the event type, the owner, the organization, the aggregate
 * and the time it happened are read out of the source row by the database,
 * with no parameter through which this service — or any future caller — could
 * state what happened instead.
 */
@Injectable()
export class DomainEventService {
  constructor(private readonly jobs: ProcessingJobService) {}

  /**
   * A revision that finished preparation and is now the institution's to read.
   *
   * READY or REVISION_READY is decided by the database from
   * `revision_number`, not by the caller, and only ever for a revision whose
   * `processing_status` really is READY.
   */
  async emitSubmissionReady(tx: TenantClient, revisionId: string): Promise<DomainEvent | null> {
    return this.emit(tx, 'app_domain_event_emit_submission_ready', revisionId);
  }

  /**
   * One institution decision.
   *
   * The system's own `null -> SUBMITTED` transition returns null: it is
   * already reported by the READY event, and emitting it here as well would
   * announce the same fact twice from two sources.
   */
  async emitDecision(tx: TenantClient, decisionEventId: string): Promise<DomainEvent | null> {
    return this.emit(tx, 'app_domain_event_emit_decision', decisionEventId);
  }

  /**
   * A standalone review comment.
   *
   * Never called for the comment `decide()` writes alongside a decision: that
   * one is part of the decision and is reported by it (§21). Calling both
   * would tell the author twice about a single act.
   */
  async emitComment(tx: TenantClient, commentId: string): Promise<DomainEvent | null> {
    return this.emit(tx, 'app_domain_event_emit_comment', commentId);
  }

  /** A certificate being issued or withdrawn, from its own immutable event. */
  async emitCertificate(tx: TenantClient, certificateEventId: string): Promise<DomainEvent | null> {
    return this.emit(tx, 'app_domain_event_emit_certificate', certificateEventId);
  }

  /**
   * One notification type derived from one attestation request-history row.
   *
   * The database decides whether that row can produce that type (a SUBMITTED
   * row produces the owner's confirmation and the reviewers' alert, and
   * nothing else), so the caller names which of the permitted pair it wants
   * and cannot invent a third.
   */
  async emitAttestation(
    tx: TenantClient,
    requestEventId: string,
    type: NotificationType,
  ): Promise<DomainEvent | null> {
    const rows: Array<{ id: string | null }> = await tx.$queryRaw`
      SELECT app_domain_event_emit_attestation(${requestEventId}::uuid, ${type}::"NotificationType") AS id`;
    return this.afterEmit(tx, rows[0]?.id ?? null);
  }

  /** One recorded expiry reminder stage. */
  async emitAttestationReminder(tx: TenantClient, reminderId: string): Promise<DomainEvent | null> {
    const rows: Array<{ id: string | null }> = await tx.$queryRaw`
      SELECT app_domain_event_emit_attestation_reminder(${reminderId}::uuid) AS id`;
    return this.afterEmit(tx, rows[0]?.id ?? null);
  }

  /**
   * One manual top-up history row: a submission tells PalCert finance, a
   * decision tells the person. Other history rows tell nobody and return null.
   *
   * The event carries no organization — a manual top-up happens to a person
   * and to PalCert — and is never projected to a webhook.
   */
  async emitManualTopUp(tx: TenantClient, requestEventId: string): Promise<DomainEvent | null> {
    const rows: Array<{ id: string | null }> = await tx.$queryRaw`
      SELECT app_domain_event_emit_manual_topup(${requestEventId}::uuid) AS id`;
    return this.afterEmit(tx, rows[0]?.id ?? null);
  }

  /**
   * Report one withdrawal history row (ADR-0150). A submission yields two
   * events — the finance alert and the requester's receipt — so this returns
   * every event it made, in order. Like a manual top-up, a withdrawal's
   * events carry no organization and are never projected to a webhook.
   */
  async emitWithdrawal(tx: TenantClient, requestEventId: string): Promise<DomainEvent[]> {
    const rows: Array<{ ids: string[] | null }> = await tx.$queryRaw`
      SELECT app_domain_event_emit_withdrawal(${requestEventId}::uuid) AS ids`;
    const events: DomainEvent[] = [];
    for (const id of rows[0]?.ids ?? []) {
      const event = await this.afterEmit(tx, id);
      if (event !== null) events.push(event);
    }
    return events;
  }

  private async emit(
    tx: TenantClient,
    fn:
      | 'app_domain_event_emit_submission_ready'
      | 'app_domain_event_emit_decision'
      | 'app_domain_event_emit_comment'
      | 'app_domain_event_emit_certificate',
    sourceId: string,
  ): Promise<DomainEvent | null> {
    // The function name is a literal from the union above, never interpolated
    // from anything a caller supplies; the row id is a bound parameter.
    const rows = await this.raw(tx, fn, sourceId);
    return this.afterEmit(tx, rows[0]?.id ?? null);
  }

  private async afterEmit(tx: TenantClient, eventId: string | null): Promise<DomainEvent | null> {
    if (eventId === null) return null;

    const event = await tx.domainEvent.findUnique({ where: { id: eventId } });
    if (event === null) return null;

    this.assertReportable(event);

    // §15: the job that will tell people is written here, in the same commit.
    // Enqueued by resource, so a retried transaction or a duplicate emit finds
    // the job it already made rather than scheduling a second fan-out.
    await this.jobs.enqueueInTransaction(tx, {
      type: ProcessingJobType.NOTIFICATION_FANOUT,
      resourceType: 'DOMAIN_EVENT',
      resourceId: event.id,
    });

    // Phase 17: and the job that will tell an organization's own systems, in
    // the same commit, for the same reason.
    //
    // Only when the row says so. The cutover is structural, so a historical
    // Phase 16 event replayed through the source identity index comes back
    // `webhookEligible = false` and is never announced — an approval from last
    // year does not reach an integration today because somebody re-ran a job.
    if (event.webhookEligible) {
      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.WEBHOOK_FANOUT,
        resourceType: 'DOMAIN_EVENT',
        resourceId: event.id,
      });
    }

    return event;
  }

  private raw(
    tx: TenantClient,
    fn: string,
    sourceId: string,
  ): Promise<Array<{ id: string | null }>> {
    switch (fn) {
      case 'app_domain_event_emit_submission_ready':
        return tx.$queryRaw`SELECT app_domain_event_emit_submission_ready(${sourceId}::uuid) AS id`;
      case 'app_domain_event_emit_decision':
        return tx.$queryRaw`SELECT app_domain_event_emit_decision(${sourceId}::uuid) AS id`;
      case 'app_domain_event_emit_comment':
        return tx.$queryRaw`SELECT app_domain_event_emit_comment(${sourceId}::uuid) AS id`;
      default:
        return tx.$queryRaw`SELECT app_domain_event_emit_certificate(${sourceId}::uuid) AS id`;
    }
  }

  /**
   * The payload allowlist, applied to the row that was actually written.
   *
   * The SQL builds the payload, so this is the check that a future edit to a
   * migration cannot slip past: the event is already in the transaction, and
   * throwing here rolls back the business change with it. Refusing to commit
   * an approval is a hard failure — which is the right trade against writing a
   * document title or an address into a durable log, where it survives in
   * backups and exports to an audience nobody chose.
   */
  private assertReportable(event: DomainEvent): void {
    if (!isNotificationType(event.eventType)) {
      throw new Error(`domain event ${event.id} has an unknown type`);
    }
    if (event.eventSchemaVersion !== DOMAIN_EVENT_SCHEMA_VERSION) {
      throw new Error(
        `domain event ${event.id} is schema version ${event.eventSchemaVersion}, not ${DOMAIN_EVENT_SCHEMA_VERSION}`,
      );
    }
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error(`domain event ${event.id} has a non-object payload`);
    }
    assertSafeEventPayload(event.eventType, payload as Record<string, unknown>);
  }
}
