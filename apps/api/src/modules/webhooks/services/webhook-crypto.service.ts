import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  WEBHOOK_CHALLENGE_BYTES,
  WEBHOOK_SIGNING_SECRET_BYTES,
  WEBHOOK_SIGNING_SECRET_PREFIX,
} from '@palcert/contracts';

import { createHmac } from 'node:crypto';

import {
  WebhookSecretPurpose,
  type SealedWebhookSecret,
  type WebhookConfigBinding,
  type WebhookRevealBinding,
} from '../../../common/crypto/webhook-keyring';
import { WebhookKeyringService } from './webhook-keyring.service';

/**
 * Making and sealing the two secrets Phase 17 holds, and the nonce it does not.
 *
 * The distinction in that sentence is the design. A signing secret and a URL
 * are sealed and kept; a verification challenge is generated, compared against
 * the immediate response, and forgotten — a persisted challenge is a persisted
 * answer key, and there is no moment at which PalCert benefits from having one.
 */
@Injectable()
export class WebhookCryptoService {
  constructor(private readonly keyring: WebhookKeyringService) {}

  /** `whsec_` + 32 random bytes, base64url. Shown once and never stored. */
  newSigningSecret(): string {
    return `${WEBHOOK_SIGNING_SECRET_PREFIX}${randomBytes(WEBHOOK_SIGNING_SECRET_BYTES).toString('base64url')}`;
  }

  /** 32 random bytes, fresh for every network attempt, never persisted. */
  newChallenge(): string {
    return randomBytes(WEBHOOK_CHALLENGE_BYTES).toString('base64url');
  }

  /**
   * A fingerprint that proves a decrypted secret is the one the row was created
   * with, and helps nobody who reads the row.
   *
   * HMAC under a fixed label with the secret as the key: the output depends on
   * the secret without being derivable back to it, and a plain hash of a
   * 32-byte random value would have been just as safe but less obviously so.
   */
  fingerprint(secret: string): string {
    return createHmac('sha256', secret).update('palcert.webhook.secret.v1').digest('hex');
  }

  sealUrl(url: string, endpointId: string, configVersionId: string): SealedWebhookSecret {
    return this.keyring.seal(
      url,
      this.configBinding(WebhookSecretPurpose.URL, endpointId, configVersionId),
    );
  }

  openUrl(sealed: SealedWebhookSecret, endpointId: string, configVersionId: string): string {
    return this.keyring.open(
      sealed,
      this.configBinding(WebhookSecretPurpose.URL, endpointId, configVersionId),
    );
  }

  sealSigningSecret(
    secret: string,
    endpointId: string,
    configVersionId: string,
  ): SealedWebhookSecret {
    return this.keyring.seal(
      secret,
      this.configBinding(WebhookSecretPurpose.SIGNING_SECRET, endpointId, configVersionId),
    );
  }

  openSigningSecret(
    sealed: SealedWebhookSecret,
    endpointId: string,
    configVersionId: string,
  ): string {
    return this.keyring.open(
      sealed,
      this.configBinding(WebhookSecretPurpose.SIGNING_SECRET, endpointId, configVersionId),
    );
  }

  sealReveal(secret: string, binding: Omit<WebhookRevealBinding, 'purpose'>): SealedWebhookSecret {
    return this.keyring.seal(secret, { purpose: WebhookSecretPurpose.SECRET_REVEAL, ...binding });
  }

  openReveal(sealed: SealedWebhookSecret, binding: Omit<WebhookRevealBinding, 'purpose'>): string {
    return this.keyring.open(sealed, {
      purpose: WebhookSecretPurpose.SECRET_REVEAL,
      ...binding,
    });
  }

  private configBinding(
    purpose: WebhookConfigBinding['purpose'],
    endpointId: string,
    configVersionId: string,
  ): WebhookConfigBinding {
    return { purpose, endpointId, configVersionId };
  }
}
