import {
  signWebhookRequest,
  verifyWebhookSignature,
  webhookSignedPayload,
} from './webhook-signature';

const SECRET = 'whsec_test_secret_value';
const BODY = Buffer.from('{"id":"whe_1","schemaVersion":1,"type":"submission.approved"}', 'utf8');

describe('webhook signatures', () => {
  it('produces the documented header shape', () => {
    const header = signWebhookRequest(SECRET, 1_789_000_000, 'dlv_1', BODY);
    expect(header).toMatch(/^t=1789000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(header, SECRET, 'dlv_1', BODY)).toBe(true);
  });

  it('binds the signature to the delivery, so one cannot be moved to another', () => {
    const header = signWebhookRequest(SECRET, 1_789_000_000, 'dlv_1', BODY);
    expect(verifyWebhookSignature(header, SECRET, 'dlv_2', BODY)).toBe(false);
  });

  it('covers the timestamp, so a replay cannot be given a fresh one', () => {
    const header = signWebhookRequest(SECRET, 1_789_000_000, 'dlv_1', BODY);
    expect(
      verifyWebhookSignature(header.replace('t=1789000000', 't=1789009999'), SECRET, 'dlv_1', BODY),
    ).toBe(false);
  });

  it('fails on a changed body byte', () => {
    const header = signWebhookRequest(SECRET, 1_789_000_000, 'dlv_1', BODY);
    expect(
      verifyWebhookSignature(header, SECRET, 'dlv_1', Buffer.concat([BODY, Buffer.from(' ')])),
    ).toBe(false);
  });

  it('fails under a different secret', () => {
    const header = signWebhookRequest(SECRET, 1_789_000_000, 'dlv_1', BODY);
    expect(verifyWebhookSignature(header, 'whsec_other', 'dlv_1', BODY)).toBe(false);
  });

  it('rejects a malformed header rather than treating it as unsigned', () => {
    for (const header of ['', 'nonsense', 't=abc,v1=00', 't=1789000000', 'v1=00']) {
      expect(verifyWebhookSignature(header, SECRET, 'dlv_1', BODY)).toBe(false);
    }
  });

  it('signs the exact bytes, not a re-serialization', () => {
    // The payload is built from the raw string. Two objects that serialize
    // differently but "mean" the same must not produce the same signature,
    // because the receiver verifies the bytes it actually received.
    expect(webhookSignedPayload(1, 'dlv_1', Buffer.from('{"a":1}')).toString()).not.toBe(
      webhookSignedPayload(1, 'dlv_1', Buffer.from('{ "a": 1 }')).toString(),
    );
  });
});
