import { createDecipheriv, randomBytes } from 'node:crypto';
import { WebhookKeyring, WebhookSecretPurpose } from '../../common/crypto/webhook-keyring';
import {
  EmailKeyUnavailableError,
  EmailSecretAuthenticationError,
  EmailSecretKeyring,
  EmailSecretPurpose,
} from './email-secret-keyring';

const SECRET = 're_TESTONLY_abcdefghijkl_7XQ';
const k1 = { kid: 'k1', key: randomBytes(32) };
const k2 = { kid: 'k2', key: randomBytes(32) };
const apiKey = { purpose: EmailSecretPurpose.API_KEY, provider: 'RESEND' } as const;

describe('EmailSecretKeyring', () => {
  it('round-trips and never stores plaintext', () => {
    const ring = new EmailSecretKeyring([k1], 'k1');
    const sealed = ring.seal(SECRET, apiKey);
    expect(sealed.kid).toBe('k1');
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('re_');
    expect(ring.open(sealed, apiKey)).toBe(SECRET);
  });

  it('uses a fresh IV for every seal', () => {
    const ring = new EmailSecretKeyring([k1], 'k1');
    const a = ring.seal(SECRET, apiKey);
    const b = ring.seal(SECRET, apiKey);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('binds ciphertext to its purpose and provider', () => {
    const ring = new EmailSecretKeyring([k1], 'k1');
    const sealed = ring.seal(SECRET, apiKey);
    expect(() =>
      ring.open(sealed, { purpose: EmailSecretPurpose.WEBHOOK_SECRET, provider: 'RESEND' }),
    ).toThrow(EmailSecretAuthenticationError);
    expect(() => ring.open(sealed, { ...apiKey, provider: 'OTHER' })).toThrow(
      EmailSecretAuthenticationError,
    );
  });

  it('fails closed on tampering, a wrong key or a missing key', () => {
    const ring = new EmailSecretKeyring([k1], 'k1');
    const sealed = ring.seal(SECRET, apiKey);
    const tampered = { ...sealed, authTag: Buffer.alloc(16).toString('base64') };
    expect(() => ring.open(tampered, apiKey)).toThrow(EmailSecretAuthenticationError);

    const otherRing = new EmailSecretKeyring([{ kid: 'k1', key: randomBytes(32) }], 'k1');
    expect(() => otherRing.open(sealed, apiKey)).toThrow(EmailSecretAuthenticationError);

    const withoutK1 = new EmailSecretKeyring([k2], 'k2');
    expect(() => withoutK1.open(sealed, apiKey)).toThrow(EmailKeyUnavailableError);
  });

  it('rotates: old key opens, active key seals, rewrap moves to the active key', () => {
    const old = new EmailSecretKeyring([k1], 'k1').seal(SECRET, apiKey);
    const ring = new EmailSecretKeyring([k1, k2], 'k2');
    expect(ring.open(old, apiKey)).toBe(SECRET);
    const rewrapped = ring.rewrap(old, apiKey);
    expect(rewrapped.kid).toBe('k2');
    expect(ring.open(rewrapped, apiKey)).toBe(SECRET);
  });

  it('error messages never contain key material or the secret', () => {
    const ring = new EmailSecretKeyring([k1], 'k1');
    const sealed = ring.seal(SECRET, apiKey);
    try {
      new EmailSecretKeyring([k2], 'k2').open(sealed, apiKey);
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
      expect(String(error)).not.toContain(k1.key.toString('base64'));
    }
  });

  it('webhook ciphertext never opens as email material under the same key', () => {
    const webhook = new WebhookKeyring([k1], 'k1');
    const sealed = webhook.seal(SECRET, {
      purpose: WebhookSecretPurpose.SIGNING_SECRET,
      endpointId: 'e',
      configVersionId: 'c',
    });
    const email = new EmailSecretKeyring([k1], 'k1');
    expect(() => email.open(sealed, apiKey)).toThrow(EmailSecretAuthenticationError);
  });
});

describe('WebhookKeyring after generalization', () => {
  it('still authenticates exactly the Phase 17 additional data', () => {
    const webhook = new WebhookKeyring([k1], 'k1');
    const binding = {
      purpose: WebhookSecretPurpose.URL,
      endpointId: 'endpoint-1',
      configVersionId: 'version-1',
    } as const;
    const sealed = webhook.seal('https://example.org/hook', binding);

    // The AAD Phase 17 wrote, reconstructed by hand: existing rows stay readable.
    const parts = ['palcert.webhook.v1', 'k1', 'WEBHOOK_URL', 'endpoint-1', 'version-1'];
    const aad = Buffer.from(parts.map((p) => `${p.length}:${p}`).join(''), 'utf8');
    const decipher = createDecipheriv('aes-256-gcm', k1.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    expect(plain).toBe('https://example.org/hook');
  });
});
