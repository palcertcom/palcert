import {
  AeadKeyring,
  type AeadKeyringEntry,
  type SealedMaterial,
} from '../../common/crypto/aead-keyring';

/**
 * Sealing for the admin-managed email provider's secrets (ADR-0146).
 *
 * The same AES-256-GCM keyring primitive the webhook subsystem uses, under a
 * separate root key (`EMAIL_SETTINGS_ENCRYPTION_KEYS`) and a separate
 * additional-data domain, so a webhook ciphertext can never open as an email
 * credential or the other way round, even if an operator reused a key.
 *
 * Each ciphertext is bound to what it is (API key or webhook secret) and to
 * the provider it was entered for. Copying the API-key ciphertext into the
 * webhook-secret columns, or relabelling the provider, makes it fail to open.
 */
export const EmailSecretPurpose = {
  API_KEY: 'EMAIL_PROVIDER_API_KEY',
  WEBHOOK_SECRET: 'EMAIL_PROVIDER_WEBHOOK_SECRET',
} as const;
export type EmailSecretPurpose = (typeof EmailSecretPurpose)[keyof typeof EmailSecretPurpose];

export interface EmailSecretBinding {
  readonly purpose: EmailSecretPurpose;
  readonly provider: string;
}

export type SealedEmailSecret = SealedMaterial;

export class EmailKeyUnavailableError extends Error {
  constructor(readonly kid: string) {
    // Names the key id, never the material and never what it protects.
    super(`email settings encryption key ${kid} is not available`);
    this.name = 'EmailKeyUnavailableError';
  }
}

export class EmailSecretAuthenticationError extends Error {
  constructor(readonly kid: string) {
    super(`sealed email settings material does not authenticate under key ${kid}`);
    this.name = 'EmailSecretAuthenticationError';
  }
}

export class EmailSecretKeyring {
  private readonly ring: AeadKeyring;

  constructor(entries: readonly AeadKeyringEntry[], activeKid: string) {
    this.ring = new AeadKeyring(entries, activeKid, {
      unavailable: (kid) => new EmailKeyUnavailableError(kid),
      unauthenticated: (kid) => new EmailSecretAuthenticationError(kid),
      invalid: (message) => new Error(`email settings encryption ${message}`),
    });
  }

  get activeKid(): string {
    return this.ring.activeKid;
  }

  has(kid: string): boolean {
    return this.ring.has(kid);
  }

  seal(plaintext: string, binding: EmailSecretBinding): SealedEmailSecret {
    return this.ring.seal(plaintext, (kid) => parts(binding, kid));
  }

  open(sealed: SealedEmailSecret, binding: EmailSecretBinding): string {
    return this.ring.open(sealed, (kid) => parts(binding, kid));
  }

  rewrap(sealed: SealedEmailSecret, binding: EmailSecretBinding): SealedEmailSecret {
    return this.ring.rewrap(sealed, (kid) => parts(binding, kid));
  }
}

function parts(binding: EmailSecretBinding, kid: string): readonly string[] {
  return ['palcert.email-settings.v1', kid, binding.purpose, binding.provider];
}
