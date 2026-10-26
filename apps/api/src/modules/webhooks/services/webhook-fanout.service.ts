import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  ALLOWED_WEBHOOK_DATA_KEYS,
  assertSafeWebhookPayload,
  buildWebhookEnvelope,
  canonicalWebhookBody,
  isWebhookEventType,
  ProcessingJobType,
  publicWebhookEventType,
  webhookBodyHash,
  type NotificationType,
  type WebhookEventType,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { WebhookGatewayService } from './webhook-gateway.service';

/**
 * Turning one committed DomainEvent into the deliveries it owes.
 *
 * The event's own content is not this service's to decide. It reads the
 * authoritative row, projects it through the same allowlist the contracts
 * package enforces, and hands the database an id and a hash; the database
 * derives the stored `data` itself. The service then reads the row back and
 * checks that its hash still describes it — which is the only way to be sure
 * the two projections agree, and the reason a disagreement is a loud failure
 * rather than a body nobody can verify later.
 */
@Injectable()
export class WebhookFanoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: WebhookGatewayService,
    private readonly jobs: ProcessingJobService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookFanoutService.name);
  }

  /**
   * Project the event, then create one delivery per subscribed ACTIVE endpoint.
   *
   * Every step is idempotent, because a redelivered fan-out job is ordinary:
   * the WebhookEvent is unique on its DomainEvent, the ORIGINAL delivery is
   * unique on (event, endpoint), and the delivery job's idempotency key is the
   * delivery id.
   */
  async fanOut(
    domainEventId: string,
  ): Promise<{ eventId: string | null; eventType: string | null; deliveries: number }> {
    const source = await this.readEligibleEvent(domainEventId);
    if (source === null) {
      // Ineligible, or a historical Phase 16 row. Nothing to answer for.
      return { eventId: null, eventType: null, deliveries: 0 };
    }

    const eventId = await this.project(source);
    const event = await this.gateway.readEvent(eventId);
    if (event === null) {
      throw new Error(`webhook event ${eventId} vanished after projection`);
    }

    this.assertBodyMatchesHash(event.id, event);

    const targets = await this.gateway.fanoutTargets(event.id);
    let created = 0;

    for (const endpointId of targets) {
      const deliveryId = await this.gateway.createOriginalDelivery(event.id, endpointId);
      if (deliveryId === null) {
        // The endpoint stopped being eligible between the query and the call.
        continue;
      }
      await this.enqueueDelivery(deliveryId);
      created += 1;
    }

    return { eventId: event.id, eventType: event.event_type, deliveries: created };
  }

  /** Enqueued outside the projection so a retry re-enqueues without re-projecting. */
  async enqueueDelivery(deliveryId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.WEBHOOK_DELIVER,
        resourceType: 'WEBHOOK_DELIVERY',
        resourceId: deliveryId,
      });
    });
  }

  /**
   * Rebuild the canonical body from what is stored and compare.
   *
   * Called here and again before every network attempt. A body that does not
   * match its hash is never sent: the signature would cover bytes the receiver
   * could not have been promised, and the likeliest cause of a mismatch is that
   * somebody changed the row.
   */
  assertBodyMatchesHash(
    eventId: string,
    event: {
      event_type: string;
      occurred_at: Date;
      organization_id: string;
      data: Record<string, unknown>;
      body_sha256: string;
    },
  ): string {
    const body = this.canonicalBodyOf(eventId, event);
    if (webhookBodyHash(body) !== event.body_sha256) {
      throw new Error(`webhook event ${eventId} body does not match its stored hash`);
    }
    return body;
  }

  canonicalBodyOf(
    eventId: string,
    event: {
      event_type: string;
      occurred_at: Date;
      organization_id: string;
      data: Record<string, unknown>;
    },
  ): string {
    if (!isWebhookEventType(event.event_type)) {
      throw new Error(`unknown webhook event type ${event.event_type}`);
    }
    return canonicalWebhookBody(
      buildWebhookEnvelope({
        webhookEventId: eventId,
        type: event.event_type,
        occurredAt: new Date(event.occurred_at),
        organizationId: event.organization_id,
        data: event.data,
      }),
    );
  }

  private async project(source: EligibleDomainEvent): Promise<string> {
    const type = publicWebhookEventType(source.event_type);
    const data = this.minimize(type, source.payload);
    assertSafeWebhookPayload(type, data);

    // The id is allocated first because it is inside the body, and the body has
    // to exist before it can be hashed.
    const webhookEventId = randomUUID();
    const body = canonicalWebhookBody(
      buildWebhookEnvelope({
        webhookEventId,
        type,
        occurredAt: new Date(source.occurred_at),
        organizationId: source.organization_id,
        data,
      }),
    );

    return this.gateway.createEvent(source.id, webhookEventId, webhookBodyHash(body));
  }

  /** The same allowlist the database applies, applied here so the hash agrees. */
  private minimize(
    type: WebhookEventType,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const allowed = ALLOWED_WEBHOOK_DATA_KEYS[type];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        data[key] = payload[key];
      }
    }
    return data;
  }

  private async readEligibleEvent(domainEventId: string): Promise<EligibleDomainEvent | null> {
    const rows = await this.prisma.$queryRawUnsafe<EligibleDomainEvent[]>(
      `SELECT "id", "event_type", "organization_id", "occurred_at", "payload",
              "event_schema_version"
         FROM "domain_events"
        WHERE "id" = $1::uuid AND "webhook_eligible"`,
      domainEventId,
    );
    return rows[0] ?? null;
  }
}

interface EligibleDomainEvent {
  readonly id: string;
  readonly event_type: NotificationType;
  readonly organization_id: string;
  readonly occurred_at: Date;
  readonly payload: Record<string, unknown>;
  readonly event_schema_version: number;
}
