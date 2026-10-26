import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signature PalCert puts on every webhook request (§23).
 *
 *     PalCert-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 *
 * The signed string is `t.deliveryId.rawBody`, and `rawBody` is the exact
 * bytes written to the socket — not a re-serialization of the object that
 * produced them. A signature computed over a second serialization is a
 * signature over something the receiver never saw, and it would fail for
 * reasons nobody could reproduce.
 *
 * Two things this does *not* do, both worth stating because both are common
 * mistakes. It does not authenticate the receiver to PalCert: the secret is
 * shared, so a valid signature proves only that whoever produced it holds the
 * secret, and both ends do. And it is not a substitute for TLS: it protects
 * integrity and origin, not confidentiality.
 *
 * The timestamp is inside the signed string so a receiver can reject an old
 * request it is being replayed. A timestamp outside it would be a timestamp
 * an attacker could edit.
 */

export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/**
 * The exact bytes that are signed: `t.deliveryId.` followed by the raw body.
 *
 * Built as a Buffer and concatenated, never as a template string, because the
 * body is bytes. Interpolating it into a string would decode and re-encode it,
 * and the signature would then cover a re-encoding rather than what went onto
 * the socket — which fails at the receiver for a reason that reproduces
 * nowhere.
 */
export function webhookSignedPayload(
  timestampSeconds: number,
  deliveryId: string,
  rawBody: Buffer,
): Buffer {
  return Buffer.concat([Buffer.from(`${timestampSeconds}.${deliveryId}.`, 'utf8'), rawBody]);
}

export function signWebhookRequest(
  secret: string,
  timestampSeconds: number,
  deliveryId: string,
  rawBody: Buffer,
): string {
  const mac = createHmac('sha256', secret)
    .update(webhookSignedPayload(timestampSeconds, deliveryId, rawBody))
    .digest('hex');
  return `t=${timestampSeconds},${WEBHOOK_SIGNATURE_VERSION}=${mac}`;
}

/**
 * Verify a header PalCert produced.
 *
 * Used by PalCert's own tests and by the documented receiver example, so the
 * comparison people copy is the timing-safe one rather than `===`.
 */
export function verifyWebhookSignature(
  header: string,
  secret: string,
  deliveryId: string,
  rawBody: Buffer,
): boolean {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const separator = piece.indexOf('=');
    if (separator <= 0) return false;
    parts.set(piece.slice(0, separator).trim(), piece.slice(separator + 1).trim());
  }

  const timestamp = Number(parts.get('t'));
  const provided = parts.get(WEBHOOK_SIGNATURE_VERSION);
  if (!Number.isInteger(timestamp) || provided === undefined) return false;

  const expected = createHmac('sha256', secret)
    .update(webhookSignedPayload(timestamp, deliveryId, rawBody))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
