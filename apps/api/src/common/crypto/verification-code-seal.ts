import { openSecret, sealSecret, type SealedSecret } from './secret-box';

/**
 * Sealing a verification code between scheduling and issuance.
 *
 * A certificate is claimed inside the transaction that records the approval
 * and rendered by a worker some time later, so the code has to survive that
 * gap somewhere. The relational row is the one place it must not survive in
 * the clear: a single SELECT over `compliance_certificates` would otherwise
 * hand the reader a working public verification for every certificate the
 * platform has ever issued.
 *
 * So it travels sealed, under a key the application holds and PostgreSQL does
 * not — which is the whole point. A database compromise on its own yields
 * ciphertext and a one-way digest, and neither is a capability.
 *
 * This reuses PalCert's existing AES-256-GCM secret box rather than inventing
 * a second crypto design; the only thing added here is the envelope shape, so
 * one nullable TEXT column can hold a sealed value.
 */

const ENVELOPE_VERSION = 1;

interface Envelope extends SealedSecret {
  readonly v: number;
}

export function sealVerificationCode(canonicalCode: string, key: Buffer): string {
  const sealed = sealSecret(canonicalCode, key);
  const envelope: Envelope = { v: ENVELOPE_VERSION, ...sealed };
  return JSON.stringify(envelope);
}

/**
 * Open a sealed code, or return null.
 *
 * Null rather than a throw for the cases a caller must handle anyway: an
 * issued certificate has had its staging material erased, and a row sealed
 * under a key that has since been rotated cannot be opened. Both mean "there
 * is no code here", and neither is an exceptional condition.
 *
 * A *tampered* ciphertext also lands here, because GCM refuses to decrypt it
 * rather than yielding attacker-chosen plaintext.
 */
export function openVerificationCode(sealed: string | null, key: Buffer): string | null {
  if (sealed === null || sealed === '') return null;
  try {
    const envelope = JSON.parse(sealed) as Partial<Envelope>;
    if (
      envelope.v !== ENVELOPE_VERSION ||
      typeof envelope.ciphertext !== 'string' ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.authTag !== 'string'
    ) {
      return null;
    }
    return openSecret(
      { ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.authTag },
      key,
    );
  } catch {
    return null;
  }
}
