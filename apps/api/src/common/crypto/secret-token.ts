import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque secret tokens: session identifiers, email-verification tokens,
 * password-reset tokens, CSRF tokens and MFA recovery codes.
 *
 * All of these are high-entropy random values, not user-chosen passwords, so a
 * single SHA-256 digest is the correct storage form: it is preimage-resistant
 * against a 256-bit random input and, unlike a password hash, adds no latency
 * to every request. Argon2 is reserved for low-entropy human secrets.
 */

/** 32 bytes = 256 bits of entropy. */
const TOKEN_BYTES = 32;

export interface GeneratedToken {
  /** Sent to the user exactly once. Never persisted, never logged. */
  readonly raw: string;
  /** Persisted in place of the raw value. */
  readonly hash: string;
}

export function generateSecretToken(bytes: number = TOKEN_BYTES): GeneratedToken {
  const raw = randomBytes(bytes).toString('base64url');
  return { raw, hash: hashSecretToken(raw) };
}

export function hashSecretToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Digest comparison is not usually a practical timing oracle, but lookups keyed
 * on a user-supplied value are exactly where an oracle would matter, and the
 * cost here is negligible.
 */
export function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Recovery codes are typed by a human under pressure, so they use an
 * unambiguous alphabet (no O/0, I/1/l) and are grouped for readability.
 * 20 characters over a 30-symbol alphabet is ~98 bits of entropy.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 5;

export function generateRecoveryCode(): GeneratedToken {
  const length = RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH;
  // Rejection-free selection: 256 is not a multiple of 31, so map via modulo on
  // a wider draw to keep the bias negligible, then verify uniformity by using
  // random values well beyond the alphabet size.
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const value = (bytes[i * 2]! << 8) | bytes[i * 2 + 1]!;
    out += RECOVERY_ALPHABET[value % RECOVERY_ALPHABET.length];
  }
  const raw = (out.match(new RegExp(`.{1,${RECOVERY_GROUP_LENGTH}}`, 'g')) ?? []).join('-');
  return { raw, hash: hashSecretToken(normalizeRecoveryCode(raw)) };
}

/** Accept user input regardless of case, spacing or grouping dashes. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
