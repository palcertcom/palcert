import { AeadKeyring, type SealedMaterial } from './aead-keyring';

/**
 * Keyring-aware authenticated encryption for Phase 17 webhook material.
 *
 * Deliberately *not* an extension of `secret-box.ts`. That envelope carries no
 * key id and no additional data, and Phase 1 and Phase 15 rows are sealed with
 * it; giving it either would change how existing ciphertext must be read. This
 * is a second, narrower primitive for material created from Phase 17 onwards.
 *
 * Two properties the older box does not have, both learned from Phase 15:
 *
 *   - Every ciphertext names the key that sealed it, so a key can be rotated
 *     without a flag day. A single key forces every stored value and the key
 *     itself to change in the same instant, which in practice means never.
 *
 *   - Every ciphertext is bound to what it is and where it belongs. A webhook
 *     URL and a webhook signing secret are both 32-ish bytes of AES-GCM under
 *     the same key; without binding, a row's URL ciphertext could be moved
 *     into its secret column and would decrypt perfectly. GCM would report
 *     success, because nothing ever told it the two were different things.
 */

/**
 * What a ciphertext is for.
 *
 * The three are never interchangeable: a URL is a destination, a signing
 * secret authenticates PalCert to a receiver, and a reveal is a copy of a
 * secret held briefly so a lost HTTP response can be recovered (§10).
 */
export const WebhookSecretPurpose = {
  URL: 'WEBHOOK_URL',
  SIGNING_SECRET: 'WEBHOOK_SIGNING_SECRET',
  SECRET_REVEAL: 'WEBHOOK_SECRET_REVEAL',
} as const;

export type WebhookSecretPurpose = (typeof WebhookSecretPurpose)[keyof typeof WebhookSecretPurpose];

/**
 * What a ciphertext is bound to (§14, §23) — and it differs by purpose,
 * because the three live in different places and are addressed differently.
 *
 * A URL and a signing secret belong to a configuration version of an endpoint,
 * so that pair is what identifies them.
 *
 * A reveal does not. It belongs to one management operation, made by one actor,
 * in one organization — and the whole point of it is that a caller comes back
 * later with an idempotency key and gets *their* secret. Binding it to the
 * endpoint and configuration alone would leave two rotations of the same
 * endpoint mutually interchangeable: A's reveal would decrypt cleanly as B's
 * recovery result, and the caller recovering B would be handed a secret the
 * receiver was never told about. So the operation, the organization and the
 * actor are all in the binding, and the endpoint and configuration are added
 * on top when they are known.
 */
export interface WebhookConfigBinding {
  readonly purpose: typeof WebhookSecretPurpose.URL | typeof WebhookSecretPurpose.SIGNING_SECRET;
  readonly endpointId: string;
  readonly configVersionId: string;
}

export interface WebhookRevealBinding {
  readonly purpose: typeof WebhookSecretPurpose.SECRET_REVEAL;
  readonly managementOperationId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  /** Bound too when known, which is always for a reveal PalCert itself wrote. */
  readonly endpointId?: string;
  readonly configVersionId?: string;
}

export type WebhookSecretBinding = WebhookConfigBinding | WebhookRevealBinding;

export type SealedWebhookSecret = SealedMaterial;

export class WebhookKeyUnavailableError extends Error {
  constructor(readonly kid: string) {
    // Names the key id, never the material and never what it was protecting.
    super(`webhook encryption key ${kid} is not available`);
    this.name = 'WebhookKeyUnavailableError';
  }
}

/**
 * The stored bytes did not authenticate under the key they name.
 *
 * Distinct from `WebhookKeyUnavailableError` on purpose, and the distinction
 * decides who is at fault. A missing key is PalCert's deployment; ciphertext
 * that will not authenticate under a key PalCert *does* hold is a row that no
 * longer describes itself, and no amount of retrying changes it.
 */
export class WebhookMaterialAuthenticationError extends Error {
  constructor(readonly kid: string) {
    super(`sealed webhook material does not authenticate under key ${kid}`);
    this.name = 'WebhookMaterialAuthenticationError';
  }
}

export interface WebhookKeyringEntry {
  readonly kid: string;
  readonly key: Buffer;
}

/**
 * The keyring: one active key that seals, and any number that only open.
 *
 * Fail-closed throughout. A referenced key that is not held is an error, never
 * an invitation to try another key — a "try them all" decryption would turn
 * the binding above into a suggestion, and would make a retired key's removal
 * silently change what a row means instead of loudly breaking.
 */
export class WebhookKeyring {
  private readonly ring: AeadKeyring;

  constructor(
    entries: readonly WebhookKeyringEntry[],
    readonly activeKid: string,
  ) {
    this.ring = new AeadKeyring(entries, activeKid, {
      unavailable: (kid) => new WebhookKeyUnavailableError(kid),
      unauthenticated: (kid) => new WebhookMaterialAuthenticationError(kid),
      invalid: (message) => new Error(`webhook encryption ${message}`),
    });
  }

  /** Every key id the ring can open with, for the readiness check (§15). */
  knownKeyIds(): readonly string[] {
    return this.ring.knownKeyIds();
  }

  has(kid: string): boolean {
    return this.ring.has(kid);
  }

  seal(plaintext: string, binding: WebhookSecretBinding): SealedWebhookSecret {
    return this.ring.seal(plaintext, (kid) => additionalDataParts(binding, kid));
  }

  /**
   * Two different failures, and callers must be able to tell them apart: a
   * key this process does not hold (`WebhookKeyUnavailableError`, the
   * deployment's fault) and material that will not authenticate under a key
   * it does hold (`WebhookMaterialAuthenticationError`, the row's).
   */
  open(sealed: SealedWebhookSecret, binding: WebhookSecretBinding): string {
    return this.ring.open(sealed, (kid) => additionalDataParts(binding, kid));
  }

  /**
   * Re-seal under the active key without changing what the value means (§15).
   *
   * The binding does not move, so the caller cannot use a rewrap to quietly
   * re-point a URL at another endpoint.
   */
  rewrap(sealed: SealedWebhookSecret, binding: WebhookSecretBinding): SealedWebhookSecret {
    return this.ring.rewrap(sealed, (kid) => additionalDataParts(binding, kid));
  }
}

/**
 * The bytes GCM authenticates alongside the ciphertext.
 *
 * Length-prefixed rather than delimiter-joined: `a|bc` and `ab|c` are the same
 * string once joined, and two different bindings that produced identical AAD
 * would let one ciphertext open under the other.
 *
 * The purpose is first and the field list differs by purpose, so a reveal's
 * AAD can never coincide with a configuration's however the ids line up.
 */
function additionalDataParts(binding: WebhookSecretBinding, kid: string): readonly string[] {
  const parts =
    binding.purpose === WebhookSecretPurpose.SECRET_REVEAL
      ? [
          'palcert.webhook.v1',
          kid,
          binding.purpose,
          binding.managementOperationId,
          binding.organizationId,
          binding.actorUserId,
          binding.endpointId ?? '',
          binding.configVersionId ?? '',
        ]
      : ['palcert.webhook.v1', kid, binding.purpose, binding.endpointId, binding.configVersionId];
  return parts;
}
