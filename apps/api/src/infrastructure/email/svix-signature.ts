import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Resend webhook, which Resend signs with Svix (ADR-0146).
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256
 * under the secret's base64-decoded bytes (after its `whsec_` prefix), and the
 * header carries one or more space-separated `v1,<base64>` signatures — more
 * than one during a secret rotation. Comparison is constant-time, and a
 * timestamp outside the tolerance is refused so a captured request cannot be
 * replayed later.
 *
 * Implemented here rather than through the `svix` package: it is twenty lines
 * of `node:crypto`, and owning it keeps the dependency surface where it was.
 */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixVerificationInput {
  readonly secret: string;
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signatureHeader: string | undefined;
  readonly body: Buffer;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}

export function verifySvixSignature(input: SvixVerificationInput): boolean {
  const { id, timestamp, signatureHeader } = input;
  if (!id || !timestamp || !signatureHeader) return false;
  if (id.length > 200 || !/^\d{1,12}$/.test(timestamp)) return false;

  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  const sentAt = Number(timestamp);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - sentAt) > tolerance) return false;

  const key = secretBytes(input.secret);
  if (key === null) return false;

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(input.body)
    .digest();

  for (const entry of signatureHeader.split(' ')) {
    const [version, signature] = entry.split(',', 2);
    if (version !== 'v1' || signature === undefined) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(signature, 'base64');
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** Sign as Svix would. For tests and the local fake only. */
export function signSvix(
  secret: string,
  id: string,
  timestamp: string,
  body: Buffer | string,
): string {
  const key = secretBytes(secret);
  if (key === null) throw new Error('invalid webhook secret');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
  return `v1,${mac}`;
}

function secretBytes(secret: string): Buffer | null {
  const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length === 0 ? null : bytes;
}
