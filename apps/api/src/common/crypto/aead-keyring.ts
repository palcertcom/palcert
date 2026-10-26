import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Keyring-aware AES-256-GCM, shared by every subsystem that stores a secret it
 * must later use: Phase 17 webhook material and the admin-managed email
 * provider credential (ADR-0146).
 *
 * Every ciphertext names the key that sealed it (rotation without a flag day)
 * and is bound, through GCM additional data, to what it is and where it
 * belongs. Each caller supplies its own additional-data parts with its own
 * domain label first, so material sealed for one subsystem can never open as
 * another's, whatever the key ring.
 *
 * Fail-closed: a referenced key that is not held is an error, never an
 * invitation to try another key, and there is no plaintext fallback.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for.
export const AEAD_KEY_BYTES = 32;

export interface AeadKeyringEntry {
  readonly kid: string;
  readonly key: Buffer;
}

export interface SealedMaterial {
  /** The key that sealed this. Persisted as its own column, not parsed out. */
  readonly kid: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

/** How a keyring reports its two failures, so each subsystem keeps its own error types. */
export interface AeadKeyringErrors {
  /** The named key is not held by this process — a deployment fact. */
  unavailable(kid: string): Error;
  /** The stored bytes do not authenticate under the key they name — a fact about the row. */
  unauthenticated(kid: string): Error;
  /** The ring itself is malformed. */
  invalid(message: string): Error;
}

/** Additional data for a seal, computed from the kid that will seal or open it. */
export type AdditionalDataParts = (kid: string) => readonly string[];

export class AeadKeyring {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    entries: readonly AeadKeyringEntry[],
    readonly activeKid: string,
    private readonly errors: AeadKeyringErrors,
  ) {
    const keys = new Map<string, Buffer>();
    for (const entry of entries) {
      if (entry.key.length !== AEAD_KEY_BYTES) {
        throw errors.invalid(`key ${entry.kid} must be ${AEAD_KEY_BYTES} bytes`);
      }
      if (keys.has(entry.kid)) {
        throw errors.invalid(`key ${entry.kid} is listed twice`);
      }
      keys.set(entry.kid, entry.key);
    }
    if (!keys.has(activeKid)) {
      throw errors.unavailable(activeKid);
    }
    this.keys = keys;
  }

  knownKeyIds(): readonly string[] {
    return [...this.keys.keys()];
  }

  has(kid: string): boolean {
    return this.keys.has(kid);
  }

  seal(plaintext: string, aad: AdditionalDataParts): SealedMaterial {
    const key = this.keyFor(this.activeKid);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(encodeAdditionalData(aad(this.activeKid)));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      kid: this.activeKid,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  /**
   * `keyFor` is outside the try: not holding the key is a fact about this
   * process; everything inside is GCM refusing to authenticate — a wrong tag,
   * a wrong binding, edited ciphertext — which is a fact about the row.
   */
  open(sealed: SealedMaterial, aad: AdditionalDataParts): string {
    const key = this.keyFor(sealed.kid);
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(encodeAdditionalData(aad(sealed.kid)));
      decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw this.errors.unauthenticated(sealed.kid);
    }
  }

  /** Re-seal under the active key without changing what the value means. */
  rewrap(sealed: SealedMaterial, aad: AdditionalDataParts): SealedMaterial {
    const plaintext = this.open(sealed, aad);
    const resealed = this.seal(plaintext, aad);
    const check = this.open(resealed, aad);
    if (!equalUtf8(check, plaintext)) {
      throw this.errors.invalid('rewrap did not reproduce the original value');
    }
    return resealed;
  }

  private keyFor(kid: string): Buffer {
    const key = this.keys.get(kid);
    if (key === undefined) {
      throw this.errors.unavailable(kid);
    }
    return key;
  }
}

/**
 * The bytes GCM authenticates alongside the ciphertext.
 *
 * Length-prefixed rather than delimiter-joined: `a|bc` and `ab|c` are the same
 * string once joined, and two different bindings that produced identical AAD
 * would let one ciphertext open under the other.
 */
export function encodeAdditionalData(parts: readonly string[]): Buffer {
  return Buffer.from(parts.map((part) => `${part.length}:${part}`).join(''), 'utf8');
}

function equalUtf8(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
