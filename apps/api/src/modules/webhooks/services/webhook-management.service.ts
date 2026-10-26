import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  AppError,
  canonicalizeJson,
  isSecretBearingOperation,
  PalCertErrorCode,
  WEBHOOK_SECRET_RECOVERY_WINDOW_MS,
  type WebhookManagementOperationType,
} from '@palcert/contracts';

import { ClockPort } from '../../auth/ports/clock.port';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookGatewayService } from './webhook-gateway.service';

/**
 * The durable identity of an HTTP mutation, and the reason a lost response is
 * recoverable.
 *
 * An idempotency key travels in a header, so it is hashed rather than stored:
 * keeping it would put a client-supplied string in the database beside the
 * resources it can re-address. The request is fingerprinted the same way, so
 * the same key with a different body is a client bug PalCert can name instead
 * of silently answering with somebody else's result.
 *
 * The recovery window exists because writing an HTTP response is not the same
 * as a client receiving one. A caller who never saw their signing secret has
 * no way to get it except to ask again with the same key, and for a bounded
 * time that returns the identical secret rather than minting a second one.
 */
@Injectable()
export class WebhookManagementService {
  constructor(
    private readonly gateway: WebhookGatewayService,
    private readonly crypto: WebhookCryptoService,
    private readonly clock: ClockPort,
  ) {}

  hashKey(idempotencyKey: string): string {
    return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
  }

  /** Canonical, so an equivalent request is the same request. */
  fingerprint(request: unknown): string {
    return createHash('sha256').update(canonicalizeJson(request), 'utf8').digest('hex');
  }

  /**
   * Look for a previous answer to this exact request.
   *
   * Three outcomes, and the distinction between the last two matters to whoever
   * is debugging: a different actor using somebody's key is a conflict, and the
   * same actor changing the body under a key they already spent is a reuse.
   */
  async findExisting(
    tx: TenantClient,
    params: {
      operation: WebhookManagementOperationType;
      idempotencyKeyHash: string;
      requestFingerprint: string;
      actorUserId: string;
    },
  ): Promise<ExistingOperation | null> {
    const found = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        actor_user_id: string;
        request_fingerprint: string;
        endpoint_id: string | null;
        config_version_id: string | null;
        delivery_id: string | null;
        reveal_expires_at: Date | null;
        reveal_available: boolean;
        settled_at: Date | null;
      }>
    >(
      `SELECT * FROM app_webhook_operation_find($1::"WebhookManagementOperationType", $2)`,
      params.operation,
      params.idempotencyKeyHash,
    );

    const existing = found[0];
    if (existing === undefined) return null;

    // Somebody else's key. Distinguished from the case below because the two
    // mean different things to whoever is debugging: this is two clients
    // sharing a key generator, that is one client changing its mind.
    if (existing.actor_user_id !== params.actorUserId) {
      throw new AppError(PalCertErrorCode.WEBHOOK_IDEMPOTENCY_KEY_CONFLICT);
    }
    if (existing.request_fingerprint !== params.requestFingerprint) {
      throw new AppError(PalCertErrorCode.WEBHOOK_IDEMPOTENCY_KEY_REUSED);
    }

    return {
      operationId: existing.id,
      endpointId: existing.endpoint_id,
      configVersionId: existing.config_version_id,
      deliveryId: existing.delivery_id,
      revealExpiresAt: existing.reveal_expires_at,
      revealAvailable: existing.reveal_available,
      settledAt: existing.settled_at,
    };
  }

  /**
   * Re-read a secret the caller may never have received.
   *
   * The binding is rebuilt from the caller's own context rather than from the
   * row, which is what makes the AAD do any work: a reveal sealed for one actor
   * in one organization will not open for another, whatever the row says.
   */
  async recoverSecret(
    tx: TenantClient,
    params: {
      operationId: string;
      idempotencyKeyHash: string;
      requestFingerprint: string;
      organizationId: string;
      actorUserId: string;
    },
  ): Promise<string> {
    const row = await this.gateway.readReveal(
      tx,
      params.operationId,
      params.idempotencyKeyHash,
      params.requestFingerprint,
      this.clock.now(),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.WEBHOOK_SECRET_NO_LONGER_RECOVERABLE);
    }

    return this.crypto.openReveal(
      {
        kid: row.reveal_encryption_key_id,
        ciphertext: row.reveal_ciphertext,
        iv: row.reveal_iv,
        authTag: row.reveal_auth_tag,
      },
      {
        managementOperationId: params.operationId,
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        ...(row.endpoint_id !== null ? { endpointId: row.endpoint_id } : {}),
        ...(row.config_version_id !== null ? { configVersionId: row.config_version_id } : {}),
      },
    );
  }

  /** The envelope a secret-bearing operation stores alongside its result. */
  sealReveal(params: {
    operationId: string;
    organizationId: string;
    actorUserId: string;
    endpointId: string;
    configVersionId: string;
    secret: string;
    operation: WebhookManagementOperationType;
  }): {
    ciphertext: string;
    iv: string;
    authTag: string;
    kid: string;
    expiresAt: Date;
  } {
    if (!isSecretBearingOperation(params.operation)) {
      throw new Error(`operation ${params.operation} does not carry a secret`);
    }

    const sealed = this.crypto.sealReveal(params.secret, {
      managementOperationId: params.operationId,
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      endpointId: params.endpointId,
      configVersionId: params.configVersionId,
    });

    return {
      ...sealed,
      expiresAt: new Date(this.clock.now().getTime() + WEBHOOK_SECRET_RECOVERY_WINDOW_MS),
    };
  }
}

export interface ExistingOperation {
  readonly operationId: string;
  readonly endpointId: string | null;
  readonly configVersionId: string | null;
  readonly deliveryId: string | null;
  readonly revealExpiresAt: Date | null;
  readonly revealAvailable: boolean;
  readonly settledAt: Date | null;
}
