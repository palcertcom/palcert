import { openSecret, sealSecret } from './secret-box';
import { normalizeEmail } from './email-normalizer';
import {
  generateRecoveryCode,
  generateSecretToken,
  hashSecretToken,
  normalizeRecoveryCode,
  secureCompare,
} from './secret-token';

describe('secret tokens', () => {
  it('generates high-entropy, unpredictable tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSecretToken().raw));
    expect(tokens.size).toBe(500);

    const sample = generateSecretToken().raw;
    // 32 random bytes base64url-encoded.
    expect(sample).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never returns the raw token as its own stored form', () => {
    const token = generateSecretToken();
    expect(token.hash).not.toBe(token.raw);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically so a presented token can be looked up', () => {
    const token = generateSecretToken();
    expect(hashSecretToken(token.raw)).toBe(token.hash);
  });

  it('produces a different digest for a token differing in one character', () => {
    expect(hashSecretToken('abcdef')).not.toBe(hashSecretToken('abcdeg'));
  });
});

describe('secureCompare', () => {
  it('matches identical values and rejects different ones', () => {
    expect(secureCompare('abc123', 'abc123')).toBe(true);
    expect(secureCompare('abc123', 'abc124')).toBe(false);
  });

  it('rejects values of different length without throwing', () => {
    expect(secureCompare('short', 'much longer value')).toBe(false);
  });
});

describe('recovery codes', () => {
  it('uses an unambiguous alphabet with no easily confused characters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRecoveryCode().raw).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789-]+$/);
    }
  });

  it('is grouped for readability but normalizes to a canonical form', () => {
    const code = generateRecoveryCode();
    expect(code.raw).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(normalizeRecoveryCode(code.raw)).toHaveLength(20);
  });

  it('accepts user input in any case, spacing or grouping', () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code.raw);

    expect(normalizeRecoveryCode(code.raw.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(code.raw.replace(/-/g, ' '))).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code.raw} `)).toBe(canonical);
  });

  it('stores a digest of the normalized code, never the code', () => {
    const code = generateRecoveryCode();
    expect(code.hash).toBe(hashSecretToken(normalizeRecoveryCode(code.raw)));
    expect(code.hash).not.toContain(code.raw);
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 300 }, () => generateRecoveryCode().raw));
    expect(codes.size).toBe(300);
  });
});

describe('secret box', () => {
  const key = Buffer.alloc(32, 9);

  it('round-trips a secret', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    expect(openSecret(sealed, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never stores the plaintext', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    expect(JSON.stringify(sealed)).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext each time (unique nonce)', () => {
    const a = sealSecret('same-secret', key);
    const b = sealSecret('same-secret', key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('refuses to decrypt with the wrong key', () => {
    const sealed = sealSecret('secret', key);
    expect(() => openSecret(sealed, Buffer.alloc(32, 1))).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const sealed = sealSecret('secret', key);
    const tampered = { ...sealed, ciphertext: Buffer.from('evil').toString('base64') };
    expect(() => openSecret(tampered, key)).toThrow();
  });

  it('rejects a key of the wrong size without disclosing its length', () => {
    expect(() => sealSecret('x', Buffer.alloc(16))).toThrow('Secret box key must be 32 bytes');
  });
});

describe('email normalization', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Ali@Example.COM ')).toBe('ali@example.com');
  });

  it('treats case variants as the same account', () => {
    expect(normalizeEmail('Researcher@University.edu')).toBe(
      normalizeEmail('researcher@university.EDU'),
    );
  });

  it('applies NFKC so visually identical addresses collapse', () => {
    // U+FF41 FULLWIDTH LATIN SMALL LETTER A normalizes to 'a'.
    expect(normalizeEmail('ａli@example.com')).toBe('ali@example.com');
  });

  it('does not strip dots or plus tags — those are provider-specific', () => {
    expect(normalizeEmail('first.last+palcert@gmail.com')).toBe('first.last+palcert@gmail.com');
  });

  it('lowercases only the last @ segment as the domain', () => {
    expect(normalizeEmail('a@b@Example.COM')).toBe('a@b@example.com');
  });

  it('handles a malformed address without throwing', () => {
    expect(normalizeEmail('not-an-email')).toBe('not-an-email');
    expect(normalizeEmail('')).toBe('');
  });

  it('preserves Arabic domain characters', () => {
    expect(normalizeEmail('user@جامعة.فلسطين')).toBe('user@جامعة.فلسطين');
  });
});
