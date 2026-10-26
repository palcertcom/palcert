import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ClockPort } from '../../auth/ports/clock.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  WebhookSecretPurpose,
  type SealedWebhookSecret,
} from '../../../common/crypto/webhook-keyring';
import { WebhookKeyringService } from './webhook-keyring.service';

/**
 * Moving stored ciphertext onto the active key, so an old key can be retired.
 *
 * Maintenance work, run by an operator command and reachable from no HTTP
 * route: the database functions it calls refuse whenever a tenant is resolved,
 * and every webhook route resolves one.
 *
 * The plaintext never changes. Each value is decrypted under the key that
 * sealed it and re-encrypted under the active one with the identical binding,
 * and the database's rewrap mode permits the crypto columns to move and
 * nothing else — so this cannot re-point a URL or activate a configuration
 * even if it tried.
 *
 * Expired reveals are wiped rather than rewrapped. Carrying a secret nobody
 * may recover onto a new key would be paying to keep something useless.
 */
/** One pass is bounded; an operator runs it until nothing is left. */
const REWRAP_LIMIT = 500;

@Injectable()
export class WebhookRewrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: WebhookKeyringService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookRewrapService.name);
  }

  /**
   * Rewrap everything not already on the active key.
   *
   * Returns counts rather than ids: an operator wants to know whether the old
   * key can be removed, and the answer is "when nothing references it".
   */
  async rewrapAll(): Promise<RewrapSummary> {
    const activeKid = this.keyring.activeKid;
    const configs = await this.rewrapConfigs(activeKid);
    const reveals = await this.rewrapReveals(activeKid);
    const remaining = (await this.keyring.referencedKeyIds()).filter((kid) => kid !== activeKid);

    this.logger.info({ activeKid, configs, reveals, remaining }, 'webhook key rewrap finished');
    return { activeKid, ...configs, ...reveals, remainingKeyIds: remaining };
  }

  private async rewrapConfigs(activeKid: string): Promise<{ configsRewrapped: number }> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        endpoint_id: string;
        url_ciphertext: string;
        url_iv: string;
        url_auth_tag: string;
        url_encryption_key_id: string;
        secret_ciphertext: string;
        secret_iv: string;
        secret_auth_tag: string;
        secret_encryption_key_id: string;
      }>
    >(`SELECT * FROM app_webhook_configs_needing_rewrap($1, $2::integer)`, activeKid, REWRAP_LIMIT);

    let configsRewrapped = 0;
    for (const row of rows) {
      const url = this.keyring.rewrap(
        {
          kid: row.url_encryption_key_id,
          ciphertext: row.url_ciphertext,
          iv: row.url_iv,
          authTag: row.url_auth_tag,
        },
        {
          purpose: WebhookSecretPurpose.URL,
          endpointId: row.endpoint_id,
          configVersionId: row.id,
        },
      );
      const secret = this.keyring.rewrap(
        {
          kid: row.secret_encryption_key_id,
          ciphertext: row.secret_ciphertext,
          iv: row.secret_iv,
          authTag: row.secret_auth_tag,
        },
        {
          purpose: WebhookSecretPurpose.SIGNING_SECRET,
          endpointId: row.endpoint_id,
          configVersionId: row.id,
        },
      );

      await this.prisma.$executeRawUnsafe(
        `SELECT app_webhook_config_rewrap($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)`,
        row.id,
        url.ciphertext,
        url.iv,
        url.authTag,
        url.kid,
        secret.ciphertext,
        secret.iv,
        secret.authTag,
        secret.kid,
      );
      configsRewrapped += 1;
    }

    return { configsRewrapped };
  }

  private async rewrapReveals(
    activeKid: string,
  ): Promise<{ revealsRewrapped: number; revealsWiped: number }> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        organization_id: string;
        actor_user_id: string;
        endpoint_id: string | null;
        config_version_id: string | null;
        reveal_ciphertext: string;
        reveal_iv: string;
        reveal_auth_tag: string;
        reveal_encryption_key_id: string;
        reveal_expires_at: Date;
      }>
    >(`SELECT * FROM app_webhook_reveals_needing_rewrap($1, $2::integer)`, activeKid, REWRAP_LIMIT);

    let revealsRewrapped = 0;
    let revealsWiped = 0;
    const now = this.clock.now();

    for (const row of rows) {
      if (row.reveal_expires_at <= now) {
        await this.prisma.$executeRawUnsafe(`SELECT app_webhook_reveal_clear($1::uuid)`, row.id);
        revealsWiped += 1;
        continue;
      }

      const sealed: SealedWebhookSecret = {
        kid: row.reveal_encryption_key_id,
        ciphertext: row.reveal_ciphertext,
        iv: row.reveal_iv,
        authTag: row.reveal_auth_tag,
      };
      const rewrapped = this.keyring.rewrap(sealed, {
        purpose: WebhookSecretPurpose.SECRET_REVEAL,
        managementOperationId: row.id,
        organizationId: row.organization_id,
        actorUserId: row.actor_user_id,
        ...(row.endpoint_id !== null ? { endpointId: row.endpoint_id } : {}),
        ...(row.config_version_id !== null ? { configVersionId: row.config_version_id } : {}),
      });

      await this.prisma.$executeRawUnsafe(
        `SELECT app_webhook_reveal_rewrap($1::uuid,$2,$3,$4,$5)`,
        row.id,
        rewrapped.ciphertext,
        rewrapped.iv,
        rewrapped.authTag,
        rewrapped.kid,
      );
      revealsRewrapped += 1;
    }

    return { revealsRewrapped, revealsWiped };
  }
}

export interface RewrapSummary {
  readonly activeKid: string;
  readonly configsRewrapped: number;
  readonly revealsRewrapped: number;
  readonly revealsWiped: number;
  /** Empty means the old key can be removed. */
  readonly remainingKeyIds: readonly string[];
}
