import { Injectable } from '@nestjs/common';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  PalCertErrorCode,
  type Page,
  type WebhookAttemptView,
  type WebhookConfigVersionView,
  type WebhookDeliveryView,
  type WebhookEndpointView,
  type WebhookOperationView,
  type WebhookPendingConfigView,
  type WebhookRotationPendingView,
  type WebhookVerificationAttemptView,
  type WebhookVerificationRequestView,
} from '@palcert/contracts';

import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { WebhookGatewayService } from './webhook-gateway.service';
import { WebhookSubscriptionService } from './webhook-subscription.service';

/** One page of history is bounded, like every list in PalCert. */
const MAX_PAGE = 50;

/**
 * Everything an organization can read about its own webhooks.
 *
 * Only tenant-safe projections: the `*_safe` views and the endpoint and
 * subscription tables, all of which row-level security already scopes. Nothing
 * here touches a SYSTEM table, and nothing here can produce a URL, a secret, a
 * challenge, a signature, a resolved address, a request body or anything a
 * receiver said — support needs to know *what happened*, which is a status, a
 * normalized code and a duration.
 */
@Injectable()
export class WebhookReadService {
  constructor(
    private readonly tenants: TenantPrismaService,
    private readonly gateway: WebhookGatewayService,
    private readonly subscriptions: WebhookSubscriptionService,
  ) {}

  async listEndpoints(tenant: TenantContext): Promise<WebhookEndpointView[]> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<EndpointRow[]>(
        `SELECT "id","organization_id","description","status","current_config_version_id",
                "pending_config_version_id","created_at","updated_at"
           FROM "webhook_endpoints" ORDER BY "created_at", "id"`,
      );
      return Promise.all(rows.map((row) => this.endpointView(tx, row)));
    });
  }

  async getEndpoint(tenant: TenantContext, endpointId: string): Promise<WebhookEndpointView> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<EndpointRow[]>(
        `SELECT "id","organization_id","description","status","current_config_version_id",
                "pending_config_version_id","created_at","updated_at"
           FROM "webhook_endpoints" WHERE "id" = $1::uuid`,
        endpointId,
      );
      const row = rows[0];
      if (row === undefined) throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_NOT_FOUND);
      return this.endpointView(tx, row);
    });
  }

  async listDeliveries(
    tenant: TenantContext,
    query: { endpointId?: string; cursor?: string; limit?: number },
  ): Promise<Page<WebhookDeliveryView>> {
    return this.inTenant(tenant, async (tx) => {
      const limit = clampLimit(query.limit);
      const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
      const rows = await tx.$queryRawUnsafe<DeliveryRow[]>(
        `SELECT * FROM "webhook_delivery_safe"
          WHERE ($1::uuid IS NULL OR "endpoint_id" = $1::uuid)
            AND ($2::timestamptz IS NULL
                 OR ("created_at", "id") < ($2::timestamptz, $3::uuid))
          ORDER BY "created_at" DESC, "id" DESC
          LIMIT ${limit + 1}`,
        query.endpointId ?? null,
        cursor?.sortValue ?? null,
        cursor?.id ?? null,
      );
      return page(rows, limit, deliveryView, (row) => [row.created_at, row.id]);
    });
  }

  async listAttempts(
    tenant: TenantContext,
    deliveryId: string,
  ): Promise<readonly WebhookAttemptView[]> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<AttemptRow[]>(
        `SELECT * FROM "webhook_delivery_attempt_safe"
          WHERE "delivery_id" = $1::uuid ORDER BY "attempt_number"`,
        deliveryId,
      );
      // An empty list from a delivery that is not the caller's is the same
      // answer as an empty list from one with no attempts yet, which is the
      // only answer either deserves.
      return rows.map(attemptView);
    });
  }

  async listVerificationAttempts(
    tenant: TenantContext,
    endpointId: string,
  ): Promise<readonly WebhookVerificationAttemptView[]> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<VerificationAttemptRow[]>(
        `SELECT * FROM "webhook_verification_attempt_safe"
          WHERE "endpoint_id" = $1::uuid ORDER BY "started_at" DESC, "attempt_number" DESC
          LIMIT ${MAX_PAGE}`,
        endpointId,
      );
      return rows.map(verificationAttemptView);
    });
  }

  async listConfigVersions(
    tenant: TenantContext,
    endpointId: string,
  ): Promise<readonly WebhookConfigVersionView[]> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<ConfigRow[]>(
        `SELECT * FROM "webhook_config_version_safe"
          WHERE "endpoint_id" = $1::uuid ORDER BY "version_number" DESC`,
        endpointId,
      );
      return rows.map(configVersionView);
    });
  }

  async rotationPending(
    tenant: TenantContext,
    endpointId: string,
  ): Promise<WebhookRotationPendingView> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ current_config_version_id: string | null }>>(
        `SELECT "current_config_version_id" FROM "webhook_endpoints" WHERE "id" = $1::uuid`,
        endpointId,
      );
      if (rows[0] === undefined) throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_NOT_FOUND);

      return {
        endpointId,
        currentConfigVersion:
          rows[0].current_config_version_id === null
            ? null
            : await this.configVersionNumber(tx, rows[0].current_config_version_id),
        unsettledOldConfigDeliveries: await this.gateway.unsettledOldConfigCount(tx, endpointId),
      };
    });
  }

  async listOperations(
    tenant: TenantContext,
    endpointId: string,
  ): Promise<readonly WebhookOperationView[]> {
    return this.inTenant(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe<OperationRow[]>(
        `SELECT * FROM "webhook_management_operation_safe"
          WHERE "endpoint_id" = $1::uuid ORDER BY "created_at" DESC LIMIT ${MAX_PAGE}`,
        endpointId,
      );
      return rows.map(operationView);
    });
  }

  // --- helpers used by the admin service, inside its own transaction --------

  async configVersionNumber(tx: TenantClient, configVersionId: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe<Array<{ version_number: number }>>(
      `SELECT "version_number" FROM "webhook_config_version_safe" WHERE "id" = $1::uuid`,
      configVersionId,
    );
    return rows[0]?.version_number ?? 0;
  }

  async verificationRequest(
    tx: TenantClient,
    operationId: string,
  ): Promise<WebhookVerificationRequestView> {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        endpoint_id: string;
        config_version_id: string;
        version_number: number;
        status: string;
      }>
    >(
      `SELECT o."endpoint_id", o."config_version_id", c."version_number", c."status"
         FROM "webhook_management_operation_safe" o
         JOIN "webhook_config_version_safe" c ON c."id" = o."config_version_id"
        WHERE o."id" = $1::uuid`,
      operationId,
    );
    const row = rows[0];
    if (row === undefined) throw new AppError(PalCertErrorCode.WEBHOOK_CONFIG_SUPERSEDED);
    return {
      operationId,
      endpointId: row.endpoint_id,
      configVersionId: row.config_version_id,
      configVersion: row.version_number,
      status: row.status as WebhookVerificationRequestView['status'],
    };
  }

  async deliveryRow(tx: TenantClient, deliveryId: string): Promise<DeliveryRow | null> {
    const rows = await tx.$queryRawUnsafe<DeliveryRow[]>(
      `SELECT * FROM "webhook_delivery_safe" WHERE "id" = $1::uuid`,
      deliveryId,
    );
    return rows[0] ?? null;
  }

  private async endpointView(tx: TenantClient, row: EndpointRow): Promise<WebhookEndpointView> {
    const current = await this.configRow(tx, row.current_config_version_id);
    const pending = await this.configRow(tx, row.pending_config_version_id);
    const subscribed = await this.subscriptions.list(tx, row.id);

    const pendingView: WebhookPendingConfigView | null =
      pending === null
        ? null
        : {
            configVersionId: pending.id,
            destination: destinationOf(pending.host, pending.port),
            subscribedEventTypes: subscribed,
            configVersion: pending.version_number,
            status: pending.status as WebhookPendingConfigView['status'],
            lastVerificationError:
              pending.last_verification_error as WebhookPendingConfigView['lastVerificationError'],
            lastVerificationAt: iso(pending.last_verification_at),
            createdAt: pending.created_at.toISOString(),
          };

    return {
      id: row.id,
      organizationId: row.organization_id,
      description: row.description,
      status: row.status as WebhookEndpointView['status'],
      destination: current === null ? '' : destinationOf(current.host, current.port),
      subscribedEventTypes: subscribed,
      configVersion: current?.version_number ?? 0,
      configStatus: (current?.status ?? 'PENDING') as WebhookEndpointView['configStatus'],
      verifiedAt: iso(current?.verified_at ?? null),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      pendingConfig: pendingView,
    };
  }

  private async configRow(tx: TenantClient, id: string | null): Promise<ConfigRow | null> {
    if (id === null) return null;
    const rows = await tx.$queryRawUnsafe<ConfigRow[]>(
      `SELECT * FROM "webhook_config_version_safe" WHERE "id" = $1::uuid`,
      id,
    );
    return rows[0] ?? null;
  }

  private inTenant<T>(tenant: TenantContext, work: (tx: TenantClient) => Promise<T>): Promise<T> {
    return this.tenants.withTenant(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      work,
    );
  }
}

/** Scheme, host and port. Never the path, which stays sealed. */
function destinationOf(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 20;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE);
}

function page<Row, View>(
  rows: Row[],
  limit: number,
  toView: (row: Row) => View,
  cursorOf: (row: Row) => [Date, string],
): Page<View> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible.at(-1);
  return {
    items: visible.map(toView),
    nextCursor: hasMore && last !== undefined ? encodeCursor(...cursorOf(last)) : null,
  };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function deliveryView(row: DeliveryRow): WebhookDeliveryView {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type as WebhookDeliveryView['eventType'],
    kind: row.kind as WebhookDeliveryView['kind'],
    status: row.status as WebhookDeliveryView['status'],
    skipReason: row.skip_reason as WebhookDeliveryView['skipReason'],
    attemptCount: row.attempt_count,
    nextAttemptAt: iso(row.next_attempt_at),
    lastErrorCode: row.last_error_code as WebhookDeliveryView['lastErrorCode'],
    responseStatusCode: row.last_http_status,
    replayOfDeliveryId: row.replay_of_delivery_id,
    createdAt: row.created_at.toISOString(),
    completedAt: iso(row.delivered_at),
  };
}

function attemptView(row: AttemptRow): WebhookAttemptView {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNumber: row.attempt_number,
    outcome: row.outcome as WebhookAttemptView['outcome'],
    errorCode: row.error_code as WebhookAttemptView['errorCode'],
    responseStatusCode: row.http_status,
    durationMs: row.duration_ms,
    startedAt: row.started_at.toISOString(),
    finishedAt: iso(row.finished_at),
  };
}

function verificationAttemptView(row: VerificationAttemptRow): WebhookVerificationAttemptView {
  return {
    id: row.id,
    operationId: row.operation_id,
    configVersionId: row.config_version_id,
    attemptNumber: row.attempt_number,
    outcome: row.outcome as WebhookVerificationAttemptView['outcome'],
    errorCode: row.error_code as WebhookVerificationAttemptView['errorCode'],
    responseStatusCode: row.http_status,
    durationMs: row.duration_ms,
    startedAt: row.started_at.toISOString(),
    finishedAt: iso(row.finished_at),
  };
}

function configVersionView(row: ConfigRow): WebhookConfigVersionView {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    configVersion: row.version_number,
    status: row.status as WebhookConfigVersionView['status'],
    destination: destinationOf(row.host, row.port),
    lastVerificationError:
      row.last_verification_error as WebhookConfigVersionView['lastVerificationError'],
    lastVerificationAt: iso(row.last_verification_at),
    createdAt: row.created_at.toISOString(),
    verifiedAt: iso(row.verified_at),
    retiredAt: iso(row.retired_at),
  };
}

function operationView(row: OperationRow): WebhookOperationView {
  return {
    id: row.id,
    operation: row.operation,
    endpointId: row.endpoint_id,
    configVersionId: row.config_version_id,
    deliveryId: row.delivery_id,
    settledAt: iso(row.settled_at),
    settledErrorCode: row.settled_error_code as WebhookOperationView['settledErrorCode'],
    createdAt: row.created_at.toISOString(),
  };
}

interface EndpointRow {
  readonly id: string;
  readonly organization_id: string;
  readonly description: string;
  readonly status: string;
  readonly current_config_version_id: string | null;
  readonly pending_config_version_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DeliveryRow {
  readonly id: string;
  readonly endpoint_id: string;
  readonly webhook_event_id: string | null;
  readonly event_type: string | null;
  readonly kind: string;
  readonly status: string;
  readonly skip_reason: string | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly last_error_code: string | null;
  readonly last_http_status: number | null;
  readonly replay_of_delivery_id: string | null;
  readonly created_at: Date;
  readonly delivered_at: Date | null;
}

interface AttemptRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly attempt_number: number;
  readonly outcome: string | null;
  readonly error_code: string | null;
  readonly http_status: number | null;
  readonly duration_ms: number | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
}

interface VerificationAttemptRow extends AttemptRow {
  readonly operation_id: string;
  readonly config_version_id: string;
}

interface ConfigRow {
  readonly id: string;
  readonly endpoint_id: string;
  readonly version_number: number;
  readonly status: string;
  readonly host: string;
  readonly port: number;
  readonly created_at: Date;
  readonly verified_at: Date | null;
  readonly retired_at: Date | null;
  readonly last_verification_error: string | null;
  readonly last_verification_at: Date | null;
}

interface OperationRow {
  readonly id: string;
  readonly operation: string;
  readonly endpoint_id: string | null;
  readonly config_version_id: string | null;
  readonly delivery_id: string | null;
  readonly settled_at: Date | null;
  readonly settled_error_code: string | null;
  readonly created_at: Date;
}
