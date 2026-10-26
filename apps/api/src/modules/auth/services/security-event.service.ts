import { Injectable } from '@nestjs/common';
import type { SecurityEventType } from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../../../infrastructure/metrics/metrics.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export interface SecurityEventContext {
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface RecordSecurityEvent extends SecurityEventContext {
  readonly type: SecurityEventType;
  readonly userId?: string | null;
  readonly actorUserId?: string | null;
  readonly metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Who acted (Phase 19).
 *
 * A discriminated union rather than two nullable ids, so a reader of the audit
 * log can never mistake "a machine did this" for "we do not know who did
 * this". Those are different facts and only one of them is a problem.
 */
export type AuditActorInput =
  | { readonly type: 'USER'; readonly userId: string }
  | { readonly type: 'API_CLIENT'; readonly apiClientId: string }
  | { readonly type: 'SYSTEM' };

export interface RecordAuditEvent {
  readonly action: string;
  /**
   * Preferred over `actorUserId`, which remains for the Phase 1 to 18 callers.
   * When both are absent the actor is SYSTEM, which is what a bare
   * `actorUserId: null` has always meant.
   */
  readonly actor?: AuditActorInput;
  readonly actorUserId?: string | null;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly beforeState?: Record<string, unknown> | null;
  readonly afterState?: Record<string, unknown> | null;
}

/**
 * Keys that must never reach a durable event record, even by accident. Event
 * payloads are attacker-visible in an incident-response export, and a leaked
 * token in an audit row is as dangerous as one in a log line.
 */
const FORBIDDEN_METADATA_KEYS =
  /(password|hash|token|secret|recovery|otp|totp|cookie|authorization|credential|verifier)/i;

@Injectable()
export class SecurityEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SecurityEventService.name);
  }

  /**
   * Record a durable security event.
   *
   * Never throws: failing to write telemetry must not fail the user's request
   * (for instance, turning a successful login into a 500).
   */
  async record(event: RecordSecurityEvent): Promise<void> {
    // Counted before the write, and unconditionally: the point of the metric
    // is that a burst of LOGIN_FAILED is visible, and it would be visible
    // least of all during the database trouble that makes the write fail.
    this.metrics.securityEvents.inc({ type: event.type });

    try {
      await this.prisma.securityEvent.create({
        data: {
          type: event.type,
          userId: event.userId ?? null,
          actorUserId: event.actorUserId ?? null,
          requestId: event.requestId ?? null,
          ipAddress: event.ipAddress ?? null,
          userAgent: event.userAgent?.slice(0, 512) ?? null,
          metadata: sanitizeMetadata(event.metadata) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, type: event.type }, 'Failed to record security event');
    }
  }

  async audit(event: RecordAuditEvent): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: auditEventData(event) });
    } catch (error) {
      this.logger.error({ err: error, action: event.action }, 'Failed to record audit event');
    }
  }

  /**
   * Record an audit event inside the caller's transaction.
   *
   * For the few changes whose record must not be separable from the change
   * itself — superseding a standard version is one: an unrecorded supersession
   * would leave a version out of force with nothing saying why. Unlike
   * `audit`, this throws, so a failed write rolls the change back with it.
   * `audit_events` is writable in every context, including a tenant one.
   */
  async auditWithin(
    tx: Pick<Prisma.TransactionClient, 'auditEvent'>,
    event: RecordAuditEvent,
  ): Promise<void> {
    await tx.auditEvent.create({ data: auditEventData(event) });
  }
}

function auditEventData(event: RecordAuditEvent): Prisma.AuditEventUncheckedCreateInput {
  const actor = resolveActor(event);
  return {
    action: event.action,
    actorType: actor.type,
    actorUserId: actor.type === 'USER' ? actor.userId : null,
    actorApiClientId: actor.type === 'API_CLIENT' ? actor.apiClientId : null,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    requestId: event.requestId ?? null,
    ipAddress: event.ipAddress ?? null,
    beforeState: (sanitizeState(event.beforeState) ?? undefined) as Prisma.InputJsonValue,
    afterState: (sanitizeState(event.afterState) ?? undefined) as Prisma.InputJsonValue,
  };
}

/**
 * The actor, from whichever of the two shapes the caller used.
 *
 * Existing callers pass `actorUserId` and keep their exact behaviour: a value
 * is a USER, an absent one is SYSTEM. That is what a nullable actor column has
 * always meant, so no historical record changes meaning.
 */
function resolveActor(event: RecordAuditEvent): AuditActorInput {
  if (event.actor !== undefined) return event.actor;
  if (typeof event.actorUserId === 'string' && event.actorUserId.length > 0) {
    return { type: 'USER', userId: event.actorUserId };
  }
  return { type: 'SYSTEM' };
}

export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !FORBIDDEN_METADATA_KEYS.test(key)),
  );
}

export function sanitizeState(
  state: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (state === null || state === undefined) return null;
  return sanitizeMetadata(state);
}
