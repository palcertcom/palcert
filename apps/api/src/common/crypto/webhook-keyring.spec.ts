import { randomBytes } from 'node:crypto';

import {
  WebhookKeyring,
  WebhookKeyUnavailableError,
  WebhookSecretPurpose,
  type SealedWebhookSecret,
  type WebhookRevealBinding,
  type WebhookSecretBinding,
} from './webhook-keyring';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

const binding: WebhookSecretBinding = {
  purpose: WebhookSecretPurpose.URL,
  endpointId: 'wep_1',
  configVersionId: 'wcv_1',
};

function ring(activeKid = 'k1'): WebhookKeyring {
  return new WebhookKeyring(
    [
      { kid: 'k1', key: KEY_A },
      { kid: 'k2', key: KEY_B },
    ],
    activeKid,
  );
}

describe('WebhookKeyring', () => {
  it('round-trips a value under the active key', () => {
    const keyring = ring();
    const sealed = keyring.seal('https://receiver.example/hook', binding);
    expect(sealed.kid).toBe('k1');
    expect(sealed.ciphertext).not.toContain('receiver.example');
    expect(keyring.open(sealed, binding)).toBe('https://receiver.example/hook');
  });

  it('still opens material sealed under a retired key', () => {
    // The point of the ring: k2 becomes active while every stored row is still
    // sealed under k1, and nothing has to change in the same instant.
    const before = ring('k1').seal('https://receiver.example/hook', binding);
    const after = ring('k2');
    expect(after.open(before, binding)).toBe('https://receiver.example/hook');
    expect(after.seal('x', binding).kid).toBe('k2');
  });

  it('fails closed on a key it does not hold, and never tries another', () => {
    const keyring = new WebhookKeyring([{ kid: 'k1', key: KEY_A }], 'k1');
    const sealed: SealedWebhookSecret = { ...keyring.seal('secret', binding), kid: 'k9' };
    expect(() => keyring.open(sealed, binding)).toThrow(WebhookKeyUnavailableError);
    expect(() => keyring.open(sealed, binding)).toThrow(/k9/);
  });

  it('refuses an active key id the ring does not contain', () => {
    expect(() => new WebhookKeyring([{ kid: 'k1', key: KEY_A }], 'k2')).toThrow(
      WebhookKeyUnavailableError,
    );
  });

  it('refuses a key of the wrong length without naming the material', () => {
    expect(() => new WebhookKeyring([{ kid: 'k1', key: randomBytes(16) }], 'k1')).toThrow(
      /must be 32 bytes/,
    );
  });

  it('will not open a URL ciphertext as a signing secret', () => {
    // Both are short strings under the same key. Without the binding, moving a
    // row's URL ciphertext into its secret column would decrypt cleanly and
    // PalCert would sign with a URL — and GCM would report success, because
    // nothing ever told it the two were different things.
    const keyring = ring();
    const sealed = keyring.seal('https://receiver.example/hook', binding);
    expect(() =>
      keyring.open(sealed, { ...binding, purpose: WebhookSecretPurpose.SIGNING_SECRET }),
    ).toThrow();
  });

  it('will not open one endpoint’s ciphertext under another endpoint', () => {
    const keyring = ring();
    const sealed = keyring.seal('https://receiver.example/hook', binding);
    expect(() => keyring.open(sealed, { ...binding, endpointId: 'wep_2' })).toThrow();
    expect(() => keyring.open(sealed, { ...binding, configVersionId: 'wcv_2' })).toThrow();
  });

  it('does not let two different bindings collide into the same authenticated data', () => {
    // `a|bc` and `ab|c` join to the same string. Length-prefixing is what stops
    // a ciphertext bound to one pair opening under the other.
    const keyring = ring();
    const sealed = keyring.seal('value', {
      purpose: WebhookSecretPurpose.URL,
      endpointId: 'ab',
      configVersionId: 'c',
    });
    expect(() =>
      keyring.open(sealed, {
        purpose: WebhookSecretPurpose.URL,
        endpointId: 'a',
        configVersionId: 'bc',
      }),
    ).toThrow();
  });

  it('detects a tampered ciphertext rather than returning altered plaintext', () => {
    const keyring = ring();
    const sealed = keyring.seal('https://receiver.example/hook', binding);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() =>
      keyring.open({ ...sealed, ciphertext: bytes.toString('base64') }, binding),
    ).toThrow();
  });

  it('rewraps under the active key without changing the value or the binding', () => {
    const old = ring('k1').seal('https://receiver.example/hook', binding);
    const keyring = ring('k2');
    const rewrapped = keyring.rewrap(old, binding);
    expect(rewrapped.kid).toBe('k2');
    expect(rewrapped.ciphertext).not.toBe(old.ciphertext);
    expect(keyring.open(rewrapped, binding)).toBe('https://receiver.example/hook');
    // The rewrap cannot be used to re-point a value at another endpoint.
    expect(() => keyring.open(rewrapped, { ...binding, endpointId: 'wep_2' })).toThrow();
  });

  it('reports which key ids it can open with', () => {
    expect([...ring().knownKeyIds()].sort()).toEqual(['k1', 'k2']);
    expect(ring().has('k2')).toBe(true);
    expect(ring().has('k9')).toBe(false);
  });
});

/**
 * A reveal is bound to the operation that produced it, not to the endpoint.
 *
 * Two rotations of the same endpoint would otherwise be interchangeable: the
 * first rotation's reveal would decrypt cleanly as the second's recovery
 * result, and a caller recovering a lost response would be handed a secret the
 * receiver was never told about — with no way for either side to notice.
 */
describe('WebhookKeyring — secret reveal binding', () => {
  const reveal: WebhookRevealBinding = {
    purpose: WebhookSecretPurpose.SECRET_REVEAL,
    managementOperationId: 'op_1',
    organizationId: 'org_1',
    actorUserId: 'usr_1',
    endpointId: 'wep_1',
    configVersionId: 'wcv_1',
  };

  function ring2(activeKid = 'k1'): WebhookKeyring {
    return new WebhookKeyring(
      [
        { kid: 'k1', key: KEY_A },
        { kid: 'k2', key: KEY_B },
      ],
      activeKid,
    );
  }

  it('round-trips under the full binding', () => {
    const keyring = ring2();
    const sealed = keyring.seal('whsec_abc', reveal);
    expect(keyring.open(sealed, reveal)).toBe('whsec_abc');
  });

  it('will not open under a different management operation', () => {
    const keyring = ring2();
    const sealed = keyring.seal('whsec_abc', reveal);
    expect(() => keyring.open(sealed, { ...reveal, managementOperationId: 'op_2' })).toThrow();
  });

  it('will not open for a different actor', () => {
    const keyring = ring2();
    const sealed = keyring.seal('whsec_abc', reveal);
    expect(() => keyring.open(sealed, { ...reveal, actorUserId: 'usr_2' })).toThrow();
  });

  it('will not open for a different organization', () => {
    const keyring = ring2();
    const sealed = keyring.seal('whsec_abc', reveal);
    expect(() => keyring.open(sealed, { ...reveal, organizationId: 'org_2' })).toThrow();
  });

  it('will not open as a signing secret, even with the same endpoint and config', () => {
    const keyring = ring2();
    const sealed = keyring.seal('whsec_abc', reveal);
    expect(() =>
      keyring.open(sealed, {
        purpose: WebhookSecretPurpose.SIGNING_SECRET,
        endpointId: 'wep_1',
        configVersionId: 'wcv_1',
      }),
    ).toThrow();
  });

  it('will not let a signing secret open as a reveal', () => {
    const keyring = ring2();
    const sealed = keyring.seal('whsec_abc', {
      purpose: WebhookSecretPurpose.SIGNING_SECRET,
      endpointId: 'wep_1',
      configVersionId: 'wcv_1',
    });
    expect(() => keyring.open(sealed, reveal)).toThrow();
  });

  it('rewraps a reveal under the active key, preserving plaintext and binding', () => {
    const old = ring2('k1').seal('whsec_abc', reveal);
    const keyring = ring2('k2');
    const rewrapped = keyring.rewrap(old, reveal);

    expect(rewrapped.kid).toBe('k2');
    expect(rewrapped.ciphertext).not.toBe(old.ciphertext);
    expect(keyring.open(rewrapped, reveal)).toBe('whsec_abc');
    // The rewrap did not loosen the binding it was sealed under.
    expect(() => keyring.open(rewrapped, { ...reveal, actorUserId: 'usr_2' })).toThrow();
    expect(() => keyring.open(rewrapped, { ...reveal, managementOperationId: 'op_2' })).toThrow();
  });
});
