import { Injectable } from '@nestjs/common';
import type {
  WebhookAttemptOutcome,
  WebhookDeliveryStatus,
  WebhookEndpointStatus,
  WebhookSkipReason,
} from '@palcert/contracts';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * The typed face of the Phase 17 database doorways.
 *
 * `palcert_app` holds no direct privilege on any Phase 17 SYSTEM table, so
 * every read and write goes through a narrow SECURITY DEFINER function. Those
 * functions are the boundary; this class exists so the rest of the code calls
 * them by name with arguments a compiler can check, and so the raw SQL lives in
 * one file instead of being scattered through six services.
 *
 * Two rules it encodes, both learned the hard way:
 *
 *   - a function returning `void` must be called through `$executeRaw`, because
 *     `$queryRaw` tries to deserialize the void column and fails;
 *   - the system functions run on the unscoped client, which is what "no user,
 *     no organization" means in practice. Handing them a tenant transaction
 *     would make every one of them refuse.
 */
@Injectable()
export class WebhookGatewayService {
  constructor(private readonly prisma: PrismaService) {}

  // --- system: projection and fan-out ---------------------------------------

  async createEvent(
    domainEventId: string,
    webhookEventId: string,
    bodySha256: string,
  ): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ app_webhook_event_create: string }>>(
      `SELECT app_webhook_event_create($1::uuid, $2::uuid, $3)`,
      domainEventId,
      webhookEventId,
      bodySha256,
    );
    return rows[0]!.app_webhook_event_create;
  }

  async readEvent(eventId: string): Promise<WebhookEventRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<WebhookEventRow[]>(
      `SELECT * FROM app_webhook_event_system_get($1::uuid)`,
      eventId,
    );
    return rows[0] ?? null;
  }

  /** Returns null when the endpoint is inactive or not subscribed. */
  async createOriginalDelivery(webhookEventId: string, endpointId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ app_webhook_delivery_create_original: string | null }>
    >(
      `SELECT app_webhook_delivery_create_original($1::uuid, $2::uuid)`,
      webhookEventId,
      endpointId,
    );
    return rows[0]?.app_webhook_delivery_create_original ?? null;
  }

  /**
   * Which endpoints an event should reach.
   *
   * A doorway rather than a query, because the RLS system-reader predicate
   * requires the role switch that only holds inside a definer body. An
   * ordinary SELECT from system context returns nothing at all — which looks
   * exactly like an organization that subscribed to nothing.
   */
  async fanoutTargets(webhookEventId: string): Promise<readonly string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ endpoint_id: string }>>(
      `SELECT * FROM app_webhook_fanout_targets($1::uuid)`,
      webhookEventId,
    );
    return rows.map((row) => row.endpoint_id);
  }

  // --- system: delivery -----------------------------------------------------

  async readDelivery(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<WebhookDeliveryRow[]>(
      `SELECT * FROM app_webhook_delivery_system_get($1::uuid)`,
      deliveryId,
    );
    return rows[0] ?? null;
  }

  async transitionDelivery(input: {
    deliveryId: string;
    status: WebhookDeliveryStatus;
    skipReason?: WebhookSkipReason | null;
    errorCode?: string | null;
    nextAttemptAt?: Date | null;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_delivery_transition(
         $1::uuid, $2::"WebhookDeliveryStatus", $3::"WebhookSkipReason",
         $4, $5::integer, $6::timestamptz, $7::boolean)`,
      input.deliveryId,
      input.status,
      input.skipReason ?? null,
      input.errorCode ?? null,
      // A receiver status belongs to the attempt that received it, and the
      // doorway refuses one here. Passed as null rather than removed from the
      // signature, so the refusal stays visible to anyone reading the call.
      null,
      input.nextAttemptAt ?? null,
      false,
    );
  }

  /**
   * Move the delivery to SENDING, count the attempt and open it — one write.
   *
   * The number comes back from the database rather than being handed to it: a
   * caller that could name the attempt number could file one out of order or
   * twice under the same number, and the delivery's history would stop being a
   * sequence. It is also the ladder's index, so it has to be the durable one.
   */
  async beginAttempt(deliveryId: string, startedAt: Date): Promise<BegunAttempt> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ attempt_id: string; attempt_number: number }>
    >(
      `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, $2::timestamptz)`,
      deliveryId,
      startedAt,
    );
    const row = rows[0]!;
    return { attemptId: row.attempt_id, attemptNumber: row.attempt_number };
  }

  async closeAttempt(input: {
    attemptId: string;
    outcome: WebhookAttemptOutcome;
    errorCode?: string | null;
    httpStatus?: number | null;
    durationMs?: number | null;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_attempt_close(
         $1::uuid, $2::"WebhookAttemptOutcome", $3, $4::integer, $5::integer)`,
      input.attemptId,
      input.outcome,
      input.errorCode ?? null,
      input.httpStatus ?? null,
      input.durationMs ?? null,
    );
  }

  /**
   * Close a real attempt and move its delivery, in one transaction.
   *
   * The attempt id is the whole authority: the delivery is derived from it
   * inside the doorway, so this cannot be pointed at an unrelated one. The
   * `Retry-After` a receiver sent was read, clamped and forgotten in memory —
   * only the resulting timestamp crosses this boundary.
   */
  async finishAttempt(input: {
    attemptId: string;
    outcome: WebhookAttemptOutcome;
    errorCode?: string | null;
    httpStatus?: number | null;
    durationMs?: number | null;
    deliveryStatus: WebhookDeliveryStatus;
    nextAttemptAt?: Date | null;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_delivery_attempt_finish(
         $1::uuid, $2::"WebhookAttemptOutcome", $3, $4::integer, $5::integer,
         $6::"WebhookDeliveryStatus", $7::timestamptz)`,
      input.attemptId,
      input.outcome,
      input.errorCode ?? null,
      input.httpStatus ?? null,
      input.durationMs ?? null,
      input.deliveryStatus,
      input.nextAttemptAt ?? null,
    );
  }

  async openAttempts(deliveryId: string): Promise<readonly WebhookAttemptRow[]> {
    return this.prisma.$queryRawUnsafe<WebhookAttemptRow[]>(
      `SELECT * FROM app_webhook_delivery_attempts_system_get($1::uuid)`,
      deliveryId,
    );
  }

  // --- system: verification -------------------------------------------------

  async readVerificationOperation(
    operationId: string,
  ): Promise<WebhookVerificationOperationRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<WebhookVerificationOperationRow[]>(
      `SELECT * FROM app_webhook_verification_operation_system_get($1::uuid)`,
      operationId,
    );
    return rows[0] ?? null;
  }

  async openVerificationAttempt(
    operationId: string,
    configVersionId: string,
    startedAt: Date,
  ): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ app_webhook_verification_attempt_open: string }>
    >(
      `SELECT app_webhook_verification_attempt_open($1::uuid, $2::uuid, $3::timestamptz)`,
      operationId,
      configVersionId,
      startedAt,
    );
    return rows[0]!.app_webhook_verification_attempt_open;
  }

  async closeVerificationAttempt(input: {
    attemptId: string;
    outcome: WebhookAttemptOutcome;
    errorCode?: string | null;
    httpStatus?: number | null;
    durationMs?: number | null;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_close(
         $1::uuid, $2::"WebhookAttemptOutcome", $3, $4::integer, $5::integer)`,
      input.attemptId,
      input.outcome,
      input.errorCode ?? null,
      input.httpStatus ?? null,
      input.durationMs ?? null,
    );
  }

  async activateConfig(verificationAttemptId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_config_activate($1::uuid)`,
      verificationAttemptId,
    );
  }

  /**
   * Close a verification attempt that got an answer, and settle the intent.
   *
   * One transaction, because the rule this phase adopted — an HTTP answer
   * settles the administrator's intent — is only true if no crash can leave the
   * answer durable and the intent still eligible for another request.
   */
  async settleVerificationResponse(input: {
    attemptId: string;
    outcome: WebhookAttemptOutcome;
    errorCode: string;
    httpStatus?: number | null;
    durationMs?: number | null;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_settle_response(
         $1::uuid, $2::"WebhookAttemptOutcome", $3, $4::integer, $5::integer)`,
      input.attemptId,
      input.outcome,
      input.errorCode,
      input.httpStatus ?? null,
      input.durationMs ?? null,
    );
  }

  /** Every attempt an operation has made, open ones included. */
  async verificationAttempts(operationId: string): Promise<readonly WebhookAttemptRow[]> {
    return this.prisma.$queryRawUnsafe<WebhookAttemptRow[]>(
      `SELECT * FROM app_webhook_verification_attempts_system_get($1::uuid)`,
      operationId,
    );
  }

  /**
   * A refusal that never reached the wire.
   *
   * Bound to the operation rather than an attempt, because there is no attempt:
   * nothing was sent. The configuration's history still records why.
   */
  async recordVerificationRefusal(operationId: string, errorCode: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_config_verification_refused($1::uuid, $2)`,
      operationId,
      errorCode,
    );
  }

  async settleOperation(operationId: string, errorCode: string | null): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `SELECT app_webhook_operation_settle($1::uuid, $2)`,
      operationId,
      errorCode,
    );
  }

  // --- system: sealed material ----------------------------------------------

  async configMaterial(configVersionId: string): Promise<WebhookConfigMaterialRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<WebhookConfigMaterialRow[]>(
      `SELECT * FROM app_webhook_config_material($1::uuid)`,
      configVersionId,
    );
    return rows[0] ?? null;
  }

  // --- tenant: management ---------------------------------------------------

  /**
   * The sealed URL of one of the caller's own configurations.
   *
   * Exists for exactly one purpose: rotating a signing secret without moving
   * the destination. It returns ciphertext and the binding needed to open it,
   * and no signing secret — rotation mints a new one, so there is never a
   * reason to decrypt the old.
   *
   * The plaintext never leaves the server: the caller opens it, re-validates it
   * against today's policy, and re-seals the identical normalized URL against
   * the new configuration id.
   */
  async configUrlMaterial(
    tx: TenantClient,
    configVersionId: string,
  ): Promise<WebhookUrlMaterialRow> {
    const rows = await tx.$queryRawUnsafe<WebhookUrlMaterialRow[]>(
      `SELECT * FROM app_webhook_config_url_material($1::uuid)`,
      configVersionId,
    );
    return rows[0]!;
  }

  async createConfig(
    tx: TenantClient,
    input: {
      configVersionId: string;
      endpointId: string;
      url: { ciphertext: string; iv: string; authTag: string; kid: string };
      urlSha256: string;
      host: string;
      port: number;
      secret: { ciphertext: string; iv: string; authTag: string; kid: string };
      secretFingerprint: string;
    },
  ): Promise<string> {
    const rows = await tx.$queryRawUnsafe<Array<{ app_webhook_config_create: string }>>(
      `SELECT app_webhook_config_create(
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::integer, $10, $11, $12, $13, $14)`,
      input.configVersionId,
      input.endpointId,
      input.url.ciphertext,
      input.url.iv,
      input.url.authTag,
      input.url.kid,
      input.urlSha256,
      input.host,
      input.port,
      input.secret.ciphertext,
      input.secret.iv,
      input.secret.authTag,
      input.secret.kid,
      input.secretFingerprint,
    );
    return rows[0]!.app_webhook_config_create;
  }

  async endpointLifecycle(
    tx: TenantClient,
    endpointId: string,
    status: WebhookEndpointStatus,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `SELECT app_webhook_endpoint_lifecycle($1::uuid, $2::"WebhookEndpointStatus")`,
      endpointId,
      status,
    );
  }

  async createOperation(
    tx: TenantClient,
    input: {
      operationId: string;
      operation: string;
      idempotencyKeyHash: string;
      requestFingerprint: string;
      endpointId?: string | null;
      configVersionId?: string | null;
      deliveryId?: string | null;
      reveal?: {
        ciphertext: string;
        iv: string;
        authTag: string;
        kid: string;
        expiresAt: Date;
      } | null;
    },
  ): Promise<string> {
    const rows = await tx.$queryRawUnsafe<
      Array<{ app_webhook_management_operation_create: string }>
    >(
      `SELECT app_webhook_management_operation_create(
         $1::uuid, $2::"WebhookManagementOperationType", $3, $4, $5::uuid, $6::uuid, $7::uuid,
         $8, $9, $10, $11, $12::timestamptz)`,
      input.operationId,
      input.operation,
      input.idempotencyKeyHash,
      input.requestFingerprint,
      input.endpointId ?? null,
      input.configVersionId ?? null,
      input.deliveryId ?? null,
      input.reveal?.ciphertext ?? null,
      input.reveal?.iv ?? null,
      input.reveal?.authTag ?? null,
      input.reveal?.kid ?? null,
      input.reveal?.expiresAt ?? null,
    );
    return rows[0]!.app_webhook_management_operation_create;
  }

  async createTestDelivery(
    tx: TenantClient,
    endpointId: string,
    controlOccurredAt: Date,
    bodySha256: string,
  ): Promise<string> {
    const rows = await tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
      `SELECT app_webhook_delivery_create_test($1::uuid, $2::timestamptz, $3)`,
      endpointId,
      controlOccurredAt,
      bodySha256,
    );
    return rows[0]!.app_webhook_delivery_create_test;
  }

  async createReplayDelivery(tx: TenantClient, sourceDeliveryId: string): Promise<string> {
    const rows = await tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_replay: string }>>(
      `SELECT app_webhook_delivery_create_replay($1::uuid)`,
      sourceDeliveryId,
    );
    return rows[0]!.app_webhook_delivery_create_replay;
  }

  /** How many unsettled deliveries still carry a configuration that is not current. */
  async unsettledOldConfigCount(tx: TenantClient, endpointId: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe<
      Array<{ app_webhook_unsettled_old_config_count: bigint }>
    >(`SELECT app_webhook_unsettled_old_config_count($1::uuid)`, endpointId);
    return Number(rows[0]!.app_webhook_unsettled_old_config_count);
  }

  async readReveal(
    tx: TenantClient,
    operationId: string,
    idempotencyKeyHash: string,
    requestFingerprint: string,
    asOf: Date,
  ): Promise<WebhookRevealRow | null> {
    const rows = await tx.$queryRawUnsafe<WebhookRevealRow[]>(
      `SELECT * FROM app_webhook_reveal_read($1::uuid, $2, $3, $4::timestamptz)`,
      operationId,
      idempotencyKeyHash,
      requestFingerprint,
      asOf,
    );
    return rows[0] ?? null;
  }
}

export interface WebhookEventRow {
  readonly id: string;
  readonly domain_event_id: string;
  readonly organization_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly occurred_at: Date;
  readonly data: Record<string, unknown>;
  readonly body_sha256: string;
}

export interface WebhookDeliveryRow {
  readonly id: string;
  readonly webhook_event_id: string | null;
  readonly endpoint_id: string;
  readonly endpoint_config_version_id: string;
  readonly organization_id: string;
  readonly kind: 'ORIGINAL' | 'REPLAY' | 'TEST';
  readonly status: WebhookDeliveryStatus;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly replay_of_delivery_id: string | null;
  readonly control_occurred_at: Date | null;
  readonly body_sha256: string | null;
  readonly event_body_sha256: string | null;
  readonly event_type: string | null;
  readonly endpoint_status: WebhookEndpointStatus;
  readonly subscribed: boolean;
}

export interface BegunAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
}

export interface WebhookAttemptRow {
  readonly id: string;
  readonly attempt_number: number;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly outcome: WebhookAttemptOutcome | null;
  readonly error_code: string | null;
  readonly http_status: number | null;
  readonly duration_ms: number | null;
}

export interface WebhookVerificationOperationRow {
  readonly id: string;
  readonly organization_id: string;
  readonly endpoint_id: string | null;
  readonly config_version_id: string | null;
  readonly settled_at: Date | null;
  readonly config_status: string | null;
  readonly endpoint_status: WebhookEndpointStatus | null;
  readonly pending_config_version_id: string | null;
  readonly succeeded_attempt_id: string | null;
  readonly attempt_count: bigint;
}

export interface WebhookUrlMaterialRow {
  readonly endpoint_id: string;
  readonly url_ciphertext: string;
  readonly url_iv: string;
  readonly url_auth_tag: string;
  readonly url_encryption_key_id: string;
  readonly url_sha256: string;
  readonly host: string;
  readonly port: number;
}

export interface WebhookConfigMaterialRow {
  readonly endpoint_id: string;
  readonly status: string;
  readonly url_ciphertext: string;
  readonly url_iv: string;
  readonly url_auth_tag: string;
  readonly url_encryption_key_id: string;
  readonly url_sha256: string;
  readonly host: string;
  readonly port: number;
  readonly secret_ciphertext: string;
  readonly secret_iv: string;
  readonly secret_auth_tag: string;
  readonly secret_encryption_key_id: string;
  readonly secret_fingerprint: string;
}

export interface WebhookRevealRow {
  readonly reveal_ciphertext: string;
  readonly reveal_iv: string;
  readonly reveal_auth_tag: string;
  readonly reveal_encryption_key_id: string;
  readonly endpoint_id: string | null;
  readonly config_version_id: string | null;
}
