import { Injectable } from '@nestjs/common';
import { isWebhookEventType, type WebhookEventType } from '@palcert/contracts';

import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * Which event types an endpoint receives.
 *
 * Normalized rows over a closed enum, with no wildcard. A missing row means
 * not subscribed, so an event type added in a later phase reaches nobody until
 * somebody asks for it — rather than starting to flow to every existing
 * integration on the day it ships.
 *
 * Replacing the set is a delete and an insert rather than an update, because a
 * subscription row is not edited: changing its event type would rewrite what an
 * organization had asked for rather than record a new choice.
 */
@Injectable()
export class WebhookSubscriptionService {
  async replace(
    tx: TenantClient,
    endpointId: string,
    organizationId: string,
    eventTypes: readonly string[],
  ): Promise<readonly WebhookEventType[]> {
    const wanted = [...new Set(eventTypes)].filter(isWebhookEventType).sort();

    await tx.$executeRawUnsafe(
      `DELETE FROM "webhook_subscriptions" WHERE "endpoint_id" = $1::uuid`,
      endpointId,
    );

    for (const eventType of wanted) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "webhook_subscriptions" ("id","endpoint_id","organization_id","event_type")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::"WebhookEventType")
         ON CONFLICT ("endpoint_id","event_type") DO NOTHING`,
        endpointId,
        organizationId,
        eventType,
      );
    }

    return wanted;
  }

  async list(tx: TenantClient, endpointId: string): Promise<readonly WebhookEventType[]> {
    const rows = await tx.$queryRawUnsafe<Array<{ event_type: WebhookEventType }>>(
      `SELECT "event_type" FROM "webhook_subscriptions"
        WHERE "endpoint_id" = $1::uuid ORDER BY "event_type"`,
      endpointId,
    );
    return rows.map((row) => row.event_type);
  }
}
