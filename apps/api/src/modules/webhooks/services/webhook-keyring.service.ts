import { Injectable, type OnModuleInit } from '@nestjs/common';
import { parseWebhookKeyring } from '@palcert/config';
import { PinoLogger } from 'nestjs-pino';

import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  WebhookKeyring,
  WebhookKeyUnavailableError,
  type SealedWebhookSecret,
  type WebhookSecretBinding,
} from '../../../common/crypto/webhook-keyring';

/**
 * The process's view of the webhook keyring, and whether it can be trusted.
 *
 * Two jobs. It builds the ring from configuration at boot, and it answers the
 * readiness question: does this process hold every key that stored ciphertext
 * still refers to?
 *
 * That second question has to be asked at startup rather than at send time.
 * A worker that discovers a missing key while delivering reports it as a
 * failure against somebody's endpoint — the organization sees their integration
 * breaking, and the actual fault is a deployment that shipped without a key.
 */
@Injectable()
export class WebhookKeyringService implements OnModuleInit {
  private keyring: WebhookKeyring | null = null;

  constructor(
    private readonly config: ApiConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookKeyringService.name);
  }

  /**
   * Build the ring, then refuse to finish starting if it is short.
   *
   * Awaited on purpose. Nest waits for this to resolve before any module that
   * depends on it initializes, so a process that cannot open its own stored
   * material never reaches the point of claiming a job. The previous shape —
   * firing the check and letting a rejected promise take the process down —
   * was a race that the worker usually won.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.webhooksEnabled) {
      this.logger.info('Webhook encryption keyring is not configured; webhooks are disabled');
      await this.assertReady();
      return;
    }

    const parsed = parseWebhookKeyring(this.config.webhookEncryptionKeys as string);
    if (parsed.errors.length > 0) {
      // Configuration was already validated at boot, so reaching here means
      // something changed underneath the process.
      throw new Error(`webhook keyring is invalid: ${parsed.errors.join('; ')}`);
    }

    this.keyring = new WebhookKeyring(
      parsed.entries.map((entry) => ({ kid: entry.kid, key: entry.key })),
      this.config.webhookEncryptionActiveKid as string,
    );

    await this.assertReady();
  }

  get enabled(): boolean {
    return this.keyring !== null;
  }

  /** Throws rather than returning null: every caller needs a real ring. */
  require(): WebhookKeyring {
    if (this.keyring === null) {
      throw new Error('webhook encryption keyring is not configured');
    }
    return this.keyring;
  }

  get activeKid(): string {
    return this.require().activeKid;
  }

  seal(plaintext: string, binding: WebhookSecretBinding): SealedWebhookSecret {
    return this.require().seal(plaintext, binding);
  }

  open(sealed: SealedWebhookSecret, binding: WebhookSecretBinding): string {
    return this.require().open(sealed, binding);
  }

  rewrap(sealed: SealedWebhookSecret, binding: WebhookSecretBinding): SealedWebhookSecret {
    return this.require().rewrap(sealed, binding);
  }

  /**
   * Which key ids stored rows still depend on.
   *
   * Read through the system doorway, because `palcert_app` holds no privilege
   * on the tables that carry key ids — which is the boundary this phase spent
   * three migrations building, and startup is not an exception to it.
   */
  async referencedKeyIds(): Promise<readonly string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ kid: string | null }>>(
      `SELECT * FROM app_webhook_referenced_key_ids()`,
    );
    return rows
      .map((row: { kid: string | null }) => row.kid)
      .filter((kid: string | null): kid is string => kid !== null);
  }

  /**
   * Fail closed if anything stored refers to a key this process does not hold.
   *
   * "No keyring configured" is not an exemption, and that was the hole. A
   * deployment that turns the feature off while sealed rows still exist has not
   * made those rows readable — it has made them unreadable by everything, and
   * the honest moment to say so is startup rather than the first delivery. An
   * installation that never configured a webhook has no referenced key ids at
   * all, so it starts exactly as before with the feature off.
   *
   * Missing keys are reported as a list of key ids and never as a count, so an
   * operator can see which key to restore. The material itself is never named,
   * here or anywhere.
   */
  async assertReady(): Promise<void> {
    const referenced = await this.referencedKeyIds();
    if (referenced.length === 0) return;

    if (this.keyring === null) {
      throw new WebhookKeyUnavailableError(referenced.join(', '));
    }

    const ring = this.keyring;
    const missing = referenced.filter((kid) => !ring.has(kid));
    if (missing.length > 0) {
      throw new WebhookKeyUnavailableError(missing.join(', '));
    }
  }
}
