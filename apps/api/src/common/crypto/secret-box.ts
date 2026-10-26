import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets that must be recoverable in plaintext —
 * currently TOTP seeds, which the server needs in order to compute codes.
 *
 * AES-256-GCM gives confidentiality plus integrity: a tampered ciphertext fails
 * to decrypt rather than yielding attacker-chosen plaintext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for.

export interface SealedSecret {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

export function sealSecret(plaintext: string, key: Buffer): SealedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function openSecret(sealed: SealedSecret, key: Buffer): string {
  assertKey(key);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    // Message deliberately omits the actual length of the configured key.
    throw new Error('Secret box key must be 32 bytes');
  }
}
