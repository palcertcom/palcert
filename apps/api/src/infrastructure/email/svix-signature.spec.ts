import { signSvix, verifySvixSignature } from './svix-signature';

const secret = `whsec_${Buffer.from('test-only-webhook-secret-123456').toString('base64')}`;
const body = Buffer.from('{"type":"email.delivered","data":{"email_id":"em_1"}}');
const now = new Date('2026-10-02T12:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));

function verify(overrides: Partial<Parameters<typeof verifySvixSignature>[0]> = {}): boolean {
  return verifySvixSignature({
    secret,
    id: 'msg_1',
    timestamp: ts,
    signatureHeader: signSvix(secret, 'msg_1', ts, body),
    body,
    now,
    ...overrides,
  });
}

describe('verifySvixSignature', () => {
  it('accepts a correct signature', () => expect(verify()).toBe(true));

  it('accepts when any of several rotated signatures matches', () => {
    expect(verify({ signatureHeader: `v1,AAAA ${signSvix(secret, 'msg_1', ts, body)}` })).toBe(
      true,
    );
  });

  it('rejects a modified body, id or timestamp', () => {
    expect(verify({ body: Buffer.from(body.toString().replace('delivered', 'bounced')) })).toBe(
      false,
    );
    expect(verify({ id: 'msg_2' })).toBe(false);
    expect(verify({ timestamp: String(Number(ts) + 1) })).toBe(false);
  });

  it('rejects the wrong secret, missing headers, other versions and stale timestamps', () => {
    const other = `whsec_${Buffer.from('another-test-secret-0000000').toString('base64')}`;
    expect(verify({ secret: other })).toBe(false);
    expect(verify({ signatureHeader: undefined })).toBe(false);
    expect(verify({ id: undefined })).toBe(false);
    expect(
      verify({ signatureHeader: signSvix(secret, 'msg_1', ts, body).replace('v1,', 'v2,') }),
    ).toBe(false);
    const old = String(Number(ts) - 600);
    expect(verify({ timestamp: old, signatureHeader: signSvix(secret, 'msg_1', old, body) })).toBe(
      false,
    );
  });
});
