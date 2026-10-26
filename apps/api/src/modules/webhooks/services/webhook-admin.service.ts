import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  AppError,
  buildWebhookTestBody,
  canonicalWebhookBody,
  isWebhookEventType,
  PalCertErrorCode,
  ProcessingJobType,
  webhookBodyHash,
  WebhookEndpointStatus,
  WebhookManagementOperationType,
  type WebhookEventType,
  type WebhookSecretRevealView,
  type WebhookVerificationRequestView,
} from '@palcert/contracts';

import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookGatewayService } from './webhook-gateway.service';
import { WebhookManagementService } from './webhook-management.service';
import { WebhookReadService } from './webhook-read.service';
import { WebhookSubscriptionService } from './webhook-subscription.service';

/**
 * Every mutation an organization can make to its own webhooks.
 *
 * All of them are durable intents first and side effects second. The
 * `WebhookManagementOperation` row is what makes a lost HTTP response
 * recoverable: the same key, from the same actor, for the same request, gets
 * the same answer rather than a second endpoint, a second secret or a second
 * replay. That is not politeness — a client whose connection dropped after a
 * create has no other way to learn the signing secret PalCert generated for
 * it, and minting a new one would mean the receiver they just configured is
 * already wrong.
 *
 * Nothing here talks to a receiver. Every outbound request in Phase 17 is made
 * by a worker holding a job lease, so a route can create an intent and a
 * delivery but never a socket.
 */
@Injectable()
export class WebhookAdminService {
  constructor(
    private readonly tenants: TenantPrismaService,
    private readonly gateway: WebhookGatewayService,
    private readonly endpoints: WebhookEndpointService,
    private readonly subscriptions: WebhookSubscriptionService,
    private readonly management: WebhookManagementService,
    private readonly reads: WebhookReadService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Record that somebody changed an organization's integration.
   *
   * Ids and a verb, never a URL and never a secret: the audit trail answers
   * "who changed what, and when", and the rest of the answer lives in the
   * configuration versions, which are immutable anyway.
   */
  private async audit(
    tenant: TenantContext,
    action: string,
    endpointId: string,
    after: Record<string, unknown> = {},
  ): Promise<void> {
    await this.events.audit({
      action,
      actorUserId: tenant.userId,
      targetType: 'WebhookEndpoint',
      targetId: endpointId,
      requestId: tenant.requestId,
      afterState: { organizationId: tenant.organizationId, ...after },
    });
  }

  // --- create ---------------------------------------------------------------

  async createEndpoint(
    tenant: TenantContext,
    input: {
      description: string;
      url: string;
      eventTypes: readonly string[];
      idempotencyKey: string;
    },
  ): Promise<WebhookSecretRevealView & { endpointId: string; operationId: string }> {
    const normalized = this.endpoints.normalizeUrl(input.url);
    const eventTypes = this.normalizeEventTypes(input.eventTypes);
    const keyHash = this.management.hashKey(input.idempotencyKey);
    // The *meaning* of the request, not the JSON that carried it: the
    // normalized URL rather than what was typed, and a sorted set rather than
    // whatever order the client listed.
    const fingerprint = this.management.fingerprint({
      description: input.description.trim(),
      url: normalized.url,
      eventTypes,
    });

    const { job, fresh, result } = await this.inTenant(tenant, async (tx) => {
      const existing = await this.management.findExisting(tx, {
        operation: WebhookManagementOperationType.CREATE_ENDPOINT,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        actorUserId: tenant.userId,
      });
      if (existing !== null) {
        // An idempotent repeat is the same endpoint being described again, not
        // a second one being created. Emitting a second "endpoint created"
        // would make the audit trail say a business mutation happened twice.
        return {
          job: null,
          fresh: false,
          result: await this.replaySecret(tx, tenant, existing, keyHash, fingerprint),
        };
      }

      const endpointId = randomUUID();
      const slot = await this.endpoints.claimSlot(tx, tenant.organizationId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "webhook_endpoints"
           ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
         VALUES ($1::uuid,$2::uuid,$3,'PENDING_VERIFICATION',$4::integer,$5::uuid,now())`,
        endpointId,
        tenant.organizationId,
        input.description.trim(),
        slot,
        tenant.userId,
      );

      const config = await this.endpoints.createConfig(tx, endpointId, input.url);
      await this.subscriptions.replace(tx, endpointId, tenant.organizationId, eventTypes);

      const operationId = randomUUID();
      const reveal = this.management.sealReveal({
        operationId,
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        endpointId,
        configVersionId: config.configVersionId,
        secret: config.signingSecret,
        operation: WebhookManagementOperationType.CREATE_ENDPOINT,
      });
      await this.gateway.createOperation(tx, {
        operationId,
        operation: WebhookManagementOperationType.CREATE_ENDPOINT,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        endpointId,
        configVersionId: config.configVersionId,
        reveal,
      });

      return {
        job: null,
        fresh: true,
        result: {
          endpointId,
          operationId,
          configVersion: await this.reads.configVersionNumber(tx, config.configVersionId),
          signingSecret: config.signingSecret,
          recoverableUntil: reveal.expiresAt.toISOString(),
        },
      };
    });

    if (job !== null) await this.dispatcher.dispatchNow(job);
    if (fresh) {
      await this.audit(tenant, 'WEBHOOK_ENDPOINT_CREATED', result.endpointId, {
        operationId: result.operationId,
        configVersion: result.configVersion,
      });
    }
    return result;
  }

  // --- description and destination -----------------------------------------

  async updateDescription(
    tenant: TenantContext,
    endpointId: string,
    description: string,
  ): Promise<void> {
    await this.inTenant(tenant, async (tx) => {
      const changed = await tx.$executeRawUnsafe(
        `UPDATE "webhook_endpoints" SET "description" = $2, "updated_at" = now()
          WHERE "id" = $1::uuid`,
        endpointId,
        description.trim(),
      );
      if (changed === 0) throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_NOT_FOUND);
    });
    await this.audit(tenant, 'WEBHOOK_ENDPOINT_RENAMED', endpointId);
  }

  /**
   * A new URL is a new configuration version, never an edit.
   *
   * The verified one keeps serving until the new one proves itself, so a typo
   * does not silently stop an organization's integration — and the old version
   * stays exactly as it was, because deliveries already in flight are bound to
   * it and their signatures have to keep meaning something.
   */
  async updateUrl(
    tenant: TenantContext,
    endpointId: string,
    input: { url: string; idempotencyKey: string },
  ): Promise<WebhookVerificationRequestView> {
    const normalized = this.endpoints.normalizeUrl(input.url);
    const keyHash = this.management.hashKey(input.idempotencyKey);
    const fingerprint = this.management.fingerprint({ endpointId, url: normalized.url });

    const { fresh, view } = await this.inTenant(tenant, async (tx) => {
      const existing = await this.management.findExisting(tx, {
        operation: WebhookManagementOperationType.UPDATE_URL,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        actorUserId: tenant.userId,
      });
      if (existing !== null) {
        return {
          fresh: false,
          view: await this.reads.verificationRequest(tx, existing.operationId),
        };
      }

      await this.requireEndpoint(tx, endpointId, { allowStatuses: OPEN_STATUSES });
      const config = await this.endpoints.createConfig(tx, endpointId, input.url);

      const operationId = randomUUID();
      await this.gateway.createOperation(tx, {
        operationId,
        operation: WebhookManagementOperationType.UPDATE_URL,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        endpointId,
        configVersionId: config.configVersionId,
      });

      return { fresh: true, view: await this.reads.verificationRequest(tx, operationId) };
    });

    if (fresh) {
      await this.audit(tenant, 'WEBHOOK_ENDPOINT_URL_CHANGED', endpointId, {
        operationId: view.operationId,
        configVersion: view.configVersion,
      });
    }
    return view;
  }

  // --- verification ---------------------------------------------------------

  /**
   * Ask PalCert to prove the pending configuration reaches somebody.
   *
   * The job is keyed by the *intent*, not by the configuration: a job keyed by
   * the configuration would have succeeded once and refused to run again, so an
   * administrator who fixed their receiver could never ask a second time. A new
   * idempotency key makes a new operation, a new job and a fresh chance.
   */
  async verify(
    tenant: TenantContext,
    endpointId: string,
    idempotencyKey: string,
  ): Promise<WebhookVerificationRequestView> {
    const keyHash = this.management.hashKey(idempotencyKey);

    const { operationId, view, fresh } = await this.inTenant(tenant, async (tx) => {
      const endpoint = await this.requireEndpoint(tx, endpointId, {
        allowStatuses: OPEN_STATUSES,
      });
      if (endpoint.pending_config_version_id === null) {
        throw new AppError(PalCertErrorCode.WEBHOOK_NO_PENDING_CONFIG);
      }
      const fingerprint = this.management.fingerprint({
        endpointId,
        configVersionId: endpoint.pending_config_version_id,
      });

      const existing = await this.management.findExisting(tx, {
        operation: WebhookManagementOperationType.VERIFY_CONFIG,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        actorUserId: tenant.userId,
      });
      if (existing !== null) {
        return {
          operationId: existing.operationId,
          view: await this.reads.verificationRequest(tx, existing.operationId),
          fresh: false,
        };
      }

      const operationId = randomUUID();
      await this.gateway.createOperation(tx, {
        operationId,
        operation: WebhookManagementOperationType.VERIFY_CONFIG,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        endpointId,
        configVersionId: endpoint.pending_config_version_id,
      });
      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.WEBHOOK_ENDPOINT_VERIFY,
        resourceType: 'WEBHOOK_VERIFICATION_OPERATION',
        resourceId: operationId,
      });

      return {
        operationId,
        view: await this.reads.verificationRequest(tx, operationId),
        fresh: true,
      };
    });

    if (fresh) {
      await this.audit(tenant, 'WEBHOOK_ENDPOINT_VERIFICATION_REQUESTED', endpointId, {
        operationId,
        configVersion: view.configVersion,
      });
    }
    await this.dispatchFor(ProcessingJobType.WEBHOOK_ENDPOINT_VERIFY, operationId);
    return view;
  }

  // --- lifecycle ------------------------------------------------------------

  async pause(tenant: TenantContext, endpointId: string): Promise<void> {
    await this.lifecycle(tenant, endpointId, WebhookEndpointStatus.PAUSED);
  }

  async resume(tenant: TenantContext, endpointId: string): Promise<void> {
    await this.lifecycle(tenant, endpointId, WebhookEndpointStatus.ACTIVE);
  }

  async disable(tenant: TenantContext, endpointId: string): Promise<void> {
    await this.lifecycle(tenant, endpointId, WebhookEndpointStatus.DISABLED);
  }

  // --- subscriptions --------------------------------------------------------

  async replaceSubscriptions(
    tenant: TenantContext,
    endpointId: string,
    eventTypes: readonly string[],
  ): Promise<readonly WebhookEventType[]> {
    const wanted = this.normalizeEventTypes(eventTypes);
    const subscribed = await this.inTenant(tenant, async (tx) => {
      await this.requireEndpoint(tx, endpointId, { allowStatuses: OPEN_STATUSES });
      return this.subscriptions.replace(tx, endpointId, tenant.organizationId, wanted);
    });
    // The event vocabulary is PalCert's own, so naming the types here reveals
    // nothing about the receiver — only which of our events it asked for.
    await this.audit(tenant, 'WEBHOOK_ENDPOINT_SUBSCRIPTIONS_REPLACED', endpointId, {
      eventTypes: [...subscribed],
    });
    return subscribed;
  }

  // --- test -----------------------------------------------------------------

  /**
   * A control message: a real signed request carrying no event.
   *
   * Its body is built from the delivery's own immutable `controlOccurredAt`, so
   * every retry reproduces exactly the same bytes, and it carries no event id
   * at all — sending one that referred to nothing would invite a receiver to
   * record it as a business event.
   */
  async test(
    tenant: TenantContext,
    endpointId: string,
    idempotencyKey: string,
  ): Promise<{ deliveryId: string; operationId: string }> {
    const keyHash = this.management.hashKey(idempotencyKey);
    const fingerprint = this.management.fingerprint({ endpointId });

    const result = await this.inTenant(tenant, async (tx) => {
      const existing = await this.management.findExisting(tx, {
        operation: WebhookManagementOperationType.TEST_ENDPOINT,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        actorUserId: tenant.userId,
      });
      if (existing !== null) {
        return {
          deliveryId: existing.deliveryId!,
          operationId: existing.operationId,
          fresh: false,
        };
      }

      await this.requireEndpoint(tx, endpointId, {
        allowStatuses: [WebhookEndpointStatus.ACTIVE],
      });

      const occurredAt = this.clock.now();
      const body = canonicalWebhookBody(buildWebhookTestBody(occurredAt));
      const deliveryId = await this.gateway.createTestDelivery(
        tx,
        endpointId,
        occurredAt,
        webhookBodyHash(body),
      );

      const operationId = randomUUID();
      await this.gateway.createOperation(tx, {
        operationId,
        operation: WebhookManagementOperationType.TEST_ENDPOINT,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        endpointId,
        deliveryId,
      });
      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.WEBHOOK_DELIVER,
        resourceType: 'WEBHOOK_DELIVERY',
        resourceId: deliveryId,
      });

      return { deliveryId, operationId, fresh: true };
    });

    if (result.fresh) {
      await this.audit(tenant, 'WEBHOOK_ENDPOINT_TEST_REQUESTED', endpointId, {
        operationId: result.operationId,
        deliveryId: result.deliveryId,
      });
      await this.dispatchFor(ProcessingJobType.WEBHOOK_DELIVER, result.deliveryId);
    }
    return { deliveryId: result.deliveryId, operationId: result.operationId };
  }

  // --- replay ---------------------------------------------------------------

  /**
   * Send a business event again, on purpose.
   *
   * A new delivery with the *same* `WebhookEvent` id, because the receiver's
   * deduplication key is the event and a replay is the same event arriving
   * again. It uses the endpoint's current verified configuration — a replay is
   * a new decision, made now, and signing it with a retired secret would ask
   * the receiver to keep one alive for ever.
   */
  async replay(
    tenant: TenantContext,
    deliveryId: string,
    idempotencyKey: string,
  ): Promise<{ deliveryId: string; operationId: string }> {
    const keyHash = this.management.hashKey(idempotencyKey);
    const fingerprint = this.management.fingerprint({ sourceDeliveryId: deliveryId });

    const result = await this.inTenant(tenant, async (tx) => {
      const existing = await this.management.findExisting(tx, {
        operation: WebhookManagementOperationType.REPLAY_DELIVERY,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        actorUserId: tenant.userId,
      });
      if (existing !== null) {
        return {
          deliveryId: existing.deliveryId!,
          operationId: existing.operationId,
          endpointId: null,
          fresh: false,
        };
      }

      const source = await this.reads.deliveryRow(tx, deliveryId);
      if (source === null) throw new AppError(PalCertErrorCode.WEBHOOK_DELIVERY_NOT_FOUND);
      if (source.kind === 'TEST') {
        throw new AppError(PalCertErrorCode.WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE);
      }
      await this.requireEndpoint(tx, source.endpoint_id, {
        allowStatuses: [WebhookEndpointStatus.ACTIVE],
      });

      const replayId = await this.gateway.createReplayDelivery(tx, deliveryId);
      const operationId = randomUUID();
      await this.gateway.createOperation(tx, {
        operationId,
        operation: WebhookManagementOperationType.REPLAY_DELIVERY,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        endpointId: source.endpoint_id,
        deliveryId: replayId,
      });
      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.WEBHOOK_DELIVER,
        resourceType: 'WEBHOOK_DELIVERY',
        resourceId: replayId,
      });

      return {
        deliveryId: replayId,
        operationId,
        endpointId: source.endpoint_id,
        fresh: true,
      };
    });

    if (result.fresh) {
      await this.audit(tenant, 'WEBHOOK_DELIVERY_REPLAYED', result.endpointId!, {
        operationId: result.operationId,
        deliveryId: result.deliveryId,
        sourceDeliveryId: deliveryId,
      });
      await this.dispatchFor(ProcessingJobType.WEBHOOK_DELIVER, result.deliveryId);
    }
    return { deliveryId: result.deliveryId, operationId: result.operationId };
  }

  // --- secret rotation ------------------------------------------------------

  /**
   * A new secret is a new configuration, and it does not take effect until it
   * is verified.
   *
   * Deliveries already in flight keep the configuration they were created with,
   * so a receiver must keep accepting the previous secret until the unsettled
   * old-configuration count reaches zero. Silently re-signing them with the new
   * secret would be the one thing a receiver cannot detect.
   */
  async rotateSecret(
    tenant: TenantContext,
    endpointId: string,
    idempotencyKey: string,
  ): Promise<WebhookSecretRevealView & { endpointId: string; operationId: string }> {
    const keyHash = this.management.hashKey(idempotencyKey);

    // The fingerprint is the *request's* meaning, and the request says only
    // "rotate the secret for this endpoint". Including the current
    // configuration id — which this operation itself changes — made the
    // recovery window useless the moment the new configuration was verified:
    // the identical retry would fingerprint against a different id and be
    // refused as a reuse, exactly when a caller who lost the response needs it
    // most. A deliberate second rotation is a new idempotency key.
    const fingerprint = this.management.fingerprint({ endpointId });

    const { fresh, result } = await this.inTenant(tenant, async (tx) => {
      const existing = await this.management.findExisting(tx, {
        operation: WebhookManagementOperationType.ROTATE_SECRET,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        actorUserId: tenant.userId,
      });
      if (existing !== null) {
        // The same rotation being re-read, not a second one: a second "secret
        // rotated" entry would claim a rotation that never happened.
        return {
          fresh: false,
          result: await this.replaySecret(tx, tenant, existing, keyHash, fingerprint),
        };
      }

      const endpoint = await this.requireEndpoint(tx, endpointId, {
        allowStatuses: OPEN_STATUSES,
      });

      // Pending first, then current. A pending configuration is the one the
      // organization most recently chose, so rotating while a URL change is
      // waiting must not throw that change away; an endpoint that has never
      // verified can still recover from a lost first secret this way.
      const source = endpoint.pending_config_version_id ?? endpoint.current_config_version_id;
      if (source === null) throw new AppError(PalCertErrorCode.WEBHOOK_NO_PENDING_CONFIG);

      const config = await this.endpoints.rotateConfig(tx, endpointId, source);

      const operationId = randomUUID();
      const reveal = this.management.sealReveal({
        operationId,
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        endpointId,
        configVersionId: config.configVersionId,
        secret: config.signingSecret,
        operation: WebhookManagementOperationType.ROTATE_SECRET,
      });
      await this.gateway.createOperation(tx, {
        operationId,
        operation: WebhookManagementOperationType.ROTATE_SECRET,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        endpointId,
        configVersionId: config.configVersionId,
        reveal,
      });

      return {
        fresh: true,
        result: {
          endpointId,
          operationId,
          configVersion: await this.reads.configVersionNumber(tx, config.configVersionId),
          signingSecret: config.signingSecret,
          recoverableUntil: reveal.expiresAt.toISOString(),
        },
      };
    });

    if (fresh) {
      await this.audit(tenant, 'WEBHOOK_ENDPOINT_SECRET_ROTATED', endpointId, {
        operationId: result.operationId,
        configVersion: result.configVersion,
      });
    }
    return result;
  }

  // --- shared ---------------------------------------------------------------

  private async lifecycle(
    tenant: TenantContext,
    endpointId: string,
    status: WebhookEndpointStatus,
  ): Promise<void> {
    await this.inTenant(tenant, async (tx) => {
      const endpoint = await this.requireEndpoint(tx, endpointId, { allowStatuses: null });
      if (endpoint.status === WebhookEndpointStatus.DISABLED) {
        throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_DISABLED);
      }
      // Resuming a paused endpoint needs something verified to resume *to*.
      if (status === WebhookEndpointStatus.ACTIVE && endpoint.current_config_version_id === null) {
        throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_NOT_VERIFIED);
      }
      try {
        await this.gateway.endpointLifecycle(tx, endpointId, status);
        await this.audit(tenant, `WEBHOOK_ENDPOINT_${status}`, endpointId);
      } catch (error) {
        // The lifecycle graph lives in the database; a refusal from it is an
        // invalid transition, not an internal fault.
        if (isLifecycleRefusal(error)) {
          throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_TRANSITION_INVALID);
        }
        throw error;
      }
    });
  }

  /**
   * Answer an idempotent repeat of a secret-bearing operation.
   *
   * Refuses on the window before it decrypts anything: the promise PalCert
   * makes is that the envelope stops being openable, and checking the clock
   * after opening it would make that promise a formality.
   */
  private async replaySecret(
    tx: TenantClient,
    tenant: TenantContext,
    existing: {
      operationId: string;
      endpointId: string | null;
      configVersionId: string | null;
      revealExpiresAt: Date | null;
      revealAvailable: boolean;
    },
    keyHash: string,
    fingerprint: string,
  ): Promise<WebhookSecretRevealView & { endpointId: string; operationId: string }> {
    if (
      !existing.revealAvailable ||
      existing.revealExpiresAt === null ||
      existing.revealExpiresAt.getTime() <= this.clock.now().getTime()
    ) {
      throw new AppError(PalCertErrorCode.WEBHOOK_IDEMPOTENCY_KEY_EXPIRED);
    }

    const signingSecret = await this.management.recoverSecret(tx, {
      operationId: existing.operationId,
      idempotencyKeyHash: keyHash,
      requestFingerprint: fingerprint,
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
    });

    return {
      endpointId: existing.endpointId!,
      operationId: existing.operationId,
      configVersion: await this.reads.configVersionNumber(tx, existing.configVersionId!),
      signingSecret,
      recoverableUntil: existing.revealExpiresAt.toISOString(),
    };
  }

  private normalizeEventTypes(eventTypes: readonly string[]): WebhookEventType[] {
    for (const eventType of eventTypes) {
      if (!isWebhookEventType(eventType)) {
        throw new AppError(PalCertErrorCode.WEBHOOK_EVENT_TYPE_INVALID);
      }
    }
    return [...new Set(eventTypes)].filter(isWebhookEventType).sort();
  }

  /**
   * The endpoint, or the not-found every other organization gets.
   *
   * Row-level security already hides another tenant's endpoint, so this
   * returning nothing is indistinguishable from the id not existing — which is
   * the point: a different error for "exists but not yours" is an existence
   * oracle for anyone who can guess an id.
   */
  private async requireEndpoint(
    tx: TenantClient,
    endpointId: string,
    options: { allowStatuses: readonly WebhookEndpointStatus[] | null },
  ): Promise<EndpointRow> {
    const rows = await tx.$queryRawUnsafe<EndpointRow[]>(
      `SELECT "id","status","current_config_version_id","pending_config_version_id"
         FROM "webhook_endpoints" WHERE "id" = $1::uuid`,
      endpointId,
    );
    const endpoint = rows[0];
    if (endpoint === undefined) throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_NOT_FOUND);

    if (options.allowStatuses !== null && !options.allowStatuses.includes(endpoint.status)) {
      throw new AppError(
        endpoint.status === WebhookEndpointStatus.DISABLED
          ? PalCertErrorCode.WEBHOOK_ENDPOINT_DISABLED
          : PalCertErrorCode.WEBHOOK_ENDPOINT_NOT_VERIFIED,
      );
    }
    return endpoint;
  }

  private inTenant<T>(tenant: TenantContext, work: (tx: TenantClient) => Promise<T>): Promise<T> {
    return this.tenants.withTenant(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      work,
    );
  }

  private async dispatchFor(type: ProcessingJobType, resourceId: string): Promise<void> {
    const job = await this.jobs.findByResource(type, resourceId);
    if (job !== null) await this.dispatcher.dispatchNow(job.id);
  }
}

/** Statuses from which an organization may still administer an endpoint. */
const OPEN_STATUSES: readonly WebhookEndpointStatus[] = [
  WebhookEndpointStatus.PENDING_VERIFICATION,
  WebhookEndpointStatus.ACTIVE,
  WebhookEndpointStatus.PAUSED,
];

interface EndpointRow {
  readonly id: string;
  readonly status: WebhookEndpointStatus;
  readonly current_config_version_id: string | null;
  readonly pending_config_version_id: string | null;
}

function isLifecycleRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /cannot move from|already DISABLED|has no verified configuration/.test(message);
}
