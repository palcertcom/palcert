export function generateTotp(secretBase32: string, at: Date): string {
  // Uses the same library the server does, so the test proves interoperability
  // rather than re-implementing (and possibly mirroring) a bug.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Secret, TOTP } = require('otpauth') as typeof import('otpauth');
  return new TOTP({
    issuer: 'PalCert',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate({ timestamp: at.getTime() });
}
