import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  AppError,
  MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION,
  PalCertErrorCode,
  validateWebhookUrl,
  WebhookEndpointStatus,
  type WebhookEventType,
} from '@palcert/contracts';

import { ApiConfigService } from '../../../config/api-config.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookGatewayService } from './webhook-gateway.service';

/**
 * Endpoints, their configurations, and the slot that bounds them.
 *
 * Creating an endpoint and saving a configuration are one act from the
 * outside — an organization gives PalCert a URL — and two rows underneath,
 * because the URL is immutable and the endpoint outlives it. Both happen in
 * one transaction so a crash cannot leave an endpoint with nowhere to send.
 */
@Injectable()
export class WebhookEndpointService {
  constructor(
    private readonly gateway: WebhookGatewayService,
    private readonly crypto: WebhookCryptoService,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * Claim the lowest free slot.
   *
   * The unique index on (organization, slot) is what actually enforces the
   * limit; this only picks a candidate. Two concurrent creates can choose the
   * same number, and one of them loses at COMMIT — which is the correct
   * outcome and the reason the count is not trusted on its own.
   */
  async claimSlot(tx: TenantClient, organizationId: string): Promise<number> {
    const taken = await tx.$queryRawUnsafe<Array<{ slot: number }>>(
      `SELECT "slot" FROM "webhook_endpoints"
        WHERE "organization_id" = $1::uuid AND "slot" IS NOT NULL
        ORDER BY "slot"`,
      organizationId,
    );
    const used = new Set(taken.map((row) => row.slot));

    for (let slot = 1; slot <= MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    throw new AppError(PalCertErrorCode.WEBHOOK_ENDPOINT_LIMIT_REACHED);
  }

  /** Validate a customer-supplied URL against the platform's policy. */
  normalizeUrl(url: string): { url: string; host: string; port: number; urlSha256: string } {
    const verdict = validateWebhookUrl(url, {
      allowedPorts: this.config.webhookAllowedPorts,
      ownHosts: this.config.webhookOwnHosts,
    });
    if (!verdict.ok) {
      throw new AppError(PalCertErrorCode.WEBHOOK_URL_NOT_ALLOWED, {
        // The reason goes to the operator who typed the URL, not into a code
        // an attacker could enumerate to map the network from outside.
        details: { reason: verdict.rejection },
      });
    }
    return verdict.value;
  }

  /**
   * Seal a URL and a fresh signing secret into a new pending configuration.
   *
   * The plaintext secret is returned because it is shown exactly once; nothing
   * stores it, and the caller is responsible for handing it straight to the
   * response and the reveal envelope.
   */
  async createConfig(
    tx: TenantClient,
    endpointId: string,
    url: string,
  ): Promise<{ configVersionId: string; signingSecret: string }> {
    const normalized = this.normalizeUrl(url);
    const signingSecret = this.crypto.newSigningSecret();

    // Allocated here because the crypto binding names it: material sealed
    // against an id the database had not chosen yet could not be opened again.
    const configVersionId = randomUUID();

    await this.gateway.createConfig(tx, {
      configVersionId,
      endpointId,
      url: this.crypto.sealUrl(normalized.url, endpointId, configVersionId),
      urlSha256: normalized.urlSha256,
      host: normalized.host,
      port: normalized.port,
      secret: this.crypto.sealSigningSecret(signingSecret, endpointId, configVersionId),
      secretFingerprint: this.crypto.fingerprint(signingSecret),
    });

    return { configVersionId, signingSecret };
  }

  /**
   * A new configuration for the same destination, with a fresh secret.
   *
   * The URL is read back from the source configuration's sealed material and
   * re-sealed against the new configuration id — exactly, path and all. Rotation
   * changes the secret and nothing else, so rebuilding the URL from anything
   * that has lost part of it (the tenant projection has no path) would silently
   * move where an organization's events go.
   *
   * It is validated again on the way through, because a destination that was
   * allowed when it was first saved may not be allowed today: a range that has
   * since been reserved, a port removed from the allow-list, a host PalCert has
   * since taken over. Rotating into a destination PalCert would now refuse is
   * not a rotation, it is a new hole.
   *
   * The old signing secret is never opened. There is no reason to read a
   * credential that is being replaced.
   */
  async rotateConfig(
    tx: TenantClient,
    endpointId: string,
    sourceConfigVersionId: string,
  ): Promise<{ configVersionId: string; signingSecret: string }> {
    const material = await this.gateway.configUrlMaterial(tx, sourceConfigVersionId);
    if (material.endpoint_id !== endpointId) {
      throw new AppError(PalCertErrorCode.WEBHOOK_CONFIG_SUPERSEDED);
    }

    const url = this.crypto.openUrl(
      {
        kid: material.url_encryption_key_id,
        ciphertext: material.url_ciphertext,
        iv: material.url_iv,
        authTag: material.url_auth_tag,
      },
      endpointId,
      sourceConfigVersionId,
    );

    return this.createConfig(tx, endpointId, url);
  }

  async pause(tx: TenantClient, endpointId: string): Promise<void> {
    await this.gateway.endpointLifecycle(tx, endpointId, WebhookEndpointStatus.PAUSED);
  }

  async resume(tx: TenantClient, endpointId: string): Promise<void> {
    await this.gateway.endpointLifecycle(tx, endpointId, WebhookEndpointStatus.ACTIVE);
  }

  async disable(tx: TenantClient, endpointId: string): Promise<void> {
    await this.gateway.endpointLifecycle(tx, endpointId, WebhookEndpointStatus.DISABLED);
  }

  async listEventTypes(tx: TenantClient, endpointId: string): Promise<WebhookEventType[]> {
    const rows = await tx.$queryRawUnsafe<Array<{ event_type: WebhookEventType }>>(
      `SELECT "event_type" FROM "webhook_subscriptions" WHERE "endpoint_id" = $1::uuid
        ORDER BY "event_type"`,
      endpointId,
    );
    return rows.map((row) => row.event_type);
  }
}
