import { AppError } from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { StubBreachedPasswordChecker } from '../ports/breached-password.port';
import { PasswordService, parsePhcHash } from './password.service';

/** Deliberately weak parameters: fast tests. Production floors are enforced by config validation. */
const TEST_ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 };

function createService(options?: {
  minLength?: number;
  maxLength?: number;
  breachedCheckEnabled?: boolean;
  breached?: Set<string>;
  argon2?: typeof TEST_ARGON2;
}): PasswordService {
  const config = {
    passwordPolicy: {
      minLength: options?.minLength ?? 12,
      maxLength: options?.maxLength ?? 256,
      breachedCheckEnabled: options?.breachedCheckEnabled ?? false,
    },
    argon2Options: options?.argon2 ?? TEST_ARGON2,
  } as unknown as ApiConfigService;

  return new PasswordService(config, new StubBreachedPasswordChecker(options?.breached));
}

describe('PasswordService hashing', () => {
  const service = createService();

  it('produces an Argon2id hash, never the plaintext', async () => {
    const hash = await service.hash('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('salts each hash so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([
      service.hash('same password'),
      service.hash('same password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await service.hash('correct horse battery staple');

    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(service.verify(hash, 'Correct horse battery staple')).resolves.toBe(false);
    await expect(service.verify(hash, '')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(service.verify('', 'anything')).resolves.toBe(false);
  });

  it('does not truncate long passphrases', async () => {
    const base = 'a'.repeat(200);
    const hash = await service.hash(`${base}ONE`);

    await expect(service.verify(hash, `${base}TWO`)).resolves.toBe(false);
    await expect(service.verify(hash, `${base}ONE`)).resolves.toBe(true);
  });

  it('accepts Arabic passphrases and preserves internal whitespace', async () => {
    const passphrase = 'كلمة السر الطويلة جدا هنا';
    const hash = await service.hash(passphrase);

    await expect(service.verify(hash, passphrase)).resolves.toBe(true);
    await expect(service.verify(hash, passphrase.replace(/ /g, ''))).resolves.toBe(false);
  });

  it('verifies the same passphrase across Unicode normalization forms', async () => {
    // Same text as NFC and NFD: a user typing on macOS vs Windows.
    const nfc = 'passwordé-with-accent';
    const hash = await service.hash(nfc);

    await expect(service.verify(hash, nfc.normalize('NFD'))).resolves.toBe(true);
  });
});

describe('PasswordService policy', () => {
  it('accepts a long passphrase with no composition requirements', async () => {
    const service = createService();
    await expect(
      service.assertMeetsPolicy('all lowercase words no digits'),
    ).resolves.toBeUndefined();
  });

  it('rejects a password shorter than the configured minimum', async () => {
    const service = createService({ minLength: 12 });
    await expect(service.assertMeetsPolicy('short')).rejects.toThrow(AppError);
    await expect(service.assertMeetsPolicy('short')).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_VIOLATION',
    });
  });

  it('measures length in code points, not UTF-16 units', async () => {
    const service = createService({ minLength: 12 });
    // 11 emoji = 22 UTF-16 units but only 11 code points, so this must fail.
    await expect(service.assertMeetsPolicy('🔐'.repeat(11))).rejects.toThrow(AppError);
    await expect(service.assertMeetsPolicy('🔐'.repeat(12))).resolves.toBeUndefined();
  });

  it('rejects rather than silently truncating an over-long password', async () => {
    const service = createService({ maxLength: 64 });
    await expect(service.assertMeetsPolicy('a'.repeat(65))).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_VIOLATION',
      details: { maxLength: 64 },
    });
  });

  it('rejects whitespace-only input', async () => {
    const service = createService();
    await expect(service.assertMeetsPolicy('               ')).rejects.toThrow(
      /only of whitespace/,
    );
  });

  it('ignores the breach list when the check is disabled', async () => {
    const service = createService({
      breachedCheckEnabled: false,
      breached: new Set(['password123456']),
    });
    await expect(service.assertMeetsPolicy('password123456')).resolves.toBeUndefined();
  });

  it('rejects a breached password when the check is enabled', async () => {
    const service = createService({
      breachedCheckEnabled: true,
      breached: new Set(['password123456']),
    });
    await expect(service.assertMeetsPolicy('password123456')).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_VIOLATION',
      details: { reason: 'BREACHED' },
    });
    await expect(service.assertMeetsPolicy('a different passphrase')).resolves.toBeUndefined();
  });
});

describe('transparent rehash', () => {
  it('does not rehash a password already at current policy', async () => {
    const service = createService();
    const hash = await service.hash('correct horse battery staple');
    expect(service.needsRehash(hash)).toBe(false);
  });

  it('flags a hash produced with weaker parameters', async () => {
    const weak = createService({ argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } });
    const weakHash = await weak.hash('correct horse battery staple');

    const strong = createService({ argon2: { memoryCost: 8192, timeCost: 3, parallelism: 1 } });
    expect(strong.needsRehash(weakHash)).toBe(true);
  });

  it('flags an unparseable or foreign hash', () => {
    const service = createService();
    expect(service.needsRehash('not-a-hash')).toBe(true);
    expect(service.needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('flags a hash from a different Argon2 variant', () => {
    const service = createService();
    expect(service.needsRehash('$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
  });
});

describe('parsePhcHash', () => {
  it('extracts algorithm and cost parameters', () => {
    expect(parsePhcHash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toEqual({
      algorithm: 'argon2id',
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  it('returns null for anything that is not a PHC Argon2 string', () => {
    expect(parsePhcHash('')).toBeNull();
    expect(parsePhcHash('plaintext-password')).toBeNull();
    expect(parsePhcHash('$scrypt$n=16384$c2FsdA$aGFzaA')).toBeNull();
  });
});
