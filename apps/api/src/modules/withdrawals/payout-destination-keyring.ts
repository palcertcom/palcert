import { Injectable } from '@nestjs/common';
import { parseWebhookKeyring } from '@palcert/config';
import { AppError, PalCertErrorCode, type PayoutDestinationDetails } from '@palcert/contracts';
import {
  AeadKeyring,
  type AeadKeyringEntry,
  type SealedMaterial,
} from '../../common/crypto/aead-keyring';
import { ApiConfigService } from '../../config/api-config.service';

/**
 * Sealing for payout destinations (ADR-0150, decision D7).
 *
 * The same AES-256-GCM keyring primitive webhooks and email settings use,
 * under its own root key (`PAYOUT_DESTINATION_ENCRYPTION_KEYS`) and its own
 * additional-data domain. Bank and wallet details have a different security
 * and rotation lifecycle from a mail provider's API key, so the two never
 * share a key — and, even if an operator pasted the same key into both, a
 * ciphertext sealed here can never open as an email secret or the other way
 * round.
 *
 * Every ciphertext is bound to what it is (a saved destination, or the frozen
 * copy on one request) and to the row it belongs to, so copying sealed
 * columns from one row to another makes them fail to open.
 */
export const PayoutSealPurpose = {
  DESTINATION: 'PAYOUT_DESTINATION',
  REQUEST_SNAPSHOT: 'WITHDRAWAL_REQUEST_SNAPSHOT',
} as const;
export type PayoutSealPurpose = (typeof PayoutSealPurpose)[keyof typeof PayoutSealPurpose];

export interface PayoutSealBinding {
  readonly purpose: PayoutSealPurpose;
  /** The destination id, or the request id for a request's frozen copy. */
  readonly recordId: string;
}

export class PayoutKeyUnavailableError extends Error {
  constructor(readonly kid: string) {
    // Names the key id, never the material and never what it protects.
    super(`payout destination encryption key ${kid} is not available`);
    this.name = 'PayoutKeyUnavailableError';
  }
}

export class PayoutSealAuthenticationError extends Error {
  constructor(readonly kid: string) {
    super(`sealed payout destination does not authenticate under key ${kid}`);
    this.name = 'PayoutSealAuthenticationError';
  }
}

/** The stored details, versioned so a later shape is recognised rather than misread. */
interface SealedDetailsDocument extends PayoutDestinationDetails {
  readonly v: 1;
}

@Injectable()
export class PayoutDestinationKeyring {
  private readonly ring: AeadKeyring | null;

  constructor(config: ApiConfigService) {
    this.ring = buildRing(config);
  }

  /** Whether this deployment can seal new destinations at all. */
  get available(): boolean {
    return this.ring !== null;
  }

  seal(details: PayoutDestinationDetails, binding: PayoutSealBinding): SealedMaterial {
    const ring = this.require();
    const document: SealedDetailsDocument = {
      v: 1,
      bankName: details.bankName,
      iban: details.iban,
      accountNumber: details.accountNumber,
      branch: details.branch,
      mobileNumber: details.mobileNumber,
      instructions: details.instructions,
    };
    return ring.seal(JSON.stringify(document), (kid) => parts(binding, kid));
  }

  open(sealed: SealedMaterial, binding: PayoutSealBinding): PayoutDestinationDetails {
    const ring = this.require();
    const plaintext = ring.open(sealed, (kid) => parts(binding, kid));
    const document = JSON.parse(plaintext) as Partial<SealedDetailsDocument>;
    if (document.v !== 1) {
      throw new PayoutSealAuthenticationError(sealed.kid);
    }
    return {
      bankName: document.bankName ?? null,
      iban: document.iban ?? null,
      accountNumber: document.accountNumber ?? null,
      branch: document.branch ?? null,
      mobileNumber: document.mobileNumber ?? null,
      instructions: document.instructions ?? null,
    };
  }

  /**
   * Refuse, in the product's own words, when no key ring is configured:
   * creating or changing a destination needs one (D7). Reading history that
   * does not open a destination keeps working without it.
   */
  private require(): AeadKeyring {
    if (this.ring === null) {
      throw new AppError(PalCertErrorCode.PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE, {
        message:
          'Payout destinations cannot be saved or opened right now because their encryption ' +
          'is not configured on this PalCert deployment.',
      });
    }
    return this.ring;
  }
}

function parts(binding: PayoutSealBinding, kid: string): readonly string[] {
  return ['palcert.payout-destinations.v1', kid, binding.purpose, binding.recordId];
}

function buildRing(config: ApiConfigService): AeadKeyring | null {
  const settings = config.payoutDestinationEncryption;
  if (settings === null) return null;
  const parsed = parseWebhookKeyring(settings.keys);
  if (parsed.errors.length > 0) {
    // Validated at boot; reaching here means configuration changed underneath.
    throw new Error(`payout destination keyring is invalid: ${parsed.errors.join('; ')}`);
  }
  const entries: AeadKeyringEntry[] = parsed.entries.map((entry) => ({
    kid: entry.kid,
    key: entry.key,
  }));
  return new AeadKeyring(entries, settings.activeKid, {
    unavailable: (kid) => new PayoutKeyUnavailableError(kid),
    unauthenticated: (kid) => new PayoutSealAuthenticationError(kid),
    invalid: (message) => new Error(`payout destination encryption ${message}`),
  });
}
