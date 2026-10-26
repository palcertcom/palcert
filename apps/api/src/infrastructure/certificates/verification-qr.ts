import * as QRCode from 'qrcode';

/**
 * The QR code on a certificate, and the one thing it is allowed to contain.
 *
 * A seam rather than an inline call, for two reasons.
 *
 * The first is the privacy rule it enforces (§41, §164): the QR carries the
 * verification URL and nothing else — no claim, no code, no identifiers, no
 * tracking parameter somebody appends later "just for analytics". Taking a
 * single `string` and building the payload here means a caller cannot pass a
 * second thing even by accident, and a test can assert exactly what was
 * handed over without rendering a PDF to find out.
 *
 * The second is determinism (§48, §162). The options below are fixed — error
 * correction, margin, scale and colours — so the same URL always produces the
 * same bytes. A caller that could choose them could make two certificates
 * with the same claim hash to different artifacts.
 */

/** Pinned so the artifact hash cannot move with a default. */
const QR_OPTIONS = {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 1,
  scale: 6,
  color: { dark: '#000000ff', light: '#ffffffff' },
} as const;

export function encodeVerificationQr(verificationUrl: string): Promise<Buffer> {
  return QRCode.toBuffer(verificationUrl, { ...QR_OPTIONS });
}
