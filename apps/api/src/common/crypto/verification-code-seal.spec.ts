import { randomBytes } from 'node:crypto';
import { generateVerificationCode } from '@palcert/contracts';
import { openVerificationCode, sealVerificationCode } from './verification-code-seal';

describe('Verification code sealing', () => {
  const key = randomBytes(32);

  it('round-trips a code', () => {
    const code = generateVerificationCode();
    expect(openVerificationCode(sealVerificationCode(code, key), key)).toBe(code);
  });

  it('produces a different sealed value every time', () => {
    // A deterministic envelope would let anybody holding the table tell which
    // two certificates share a code, and would leak equality across rotations.
    const code = generateVerificationCode();
    const first = sealVerificationCode(code, key);
    const second = sealVerificationCode(code, key);
    expect(first).not.toBe(second);
    expect(openVerificationCode(first, key)).toBe(openVerificationCode(second, key));
  });

  it('never contains the code it seals', () => {
    const code = generateVerificationCode();
    const sealed = sealVerificationCode(code, key);
    expect(sealed).not.toContain(code);
    expect(sealed).not.toContain(code.slice(0, 8));
    // And not in any decoded form either: base64 of the plaintext would be a
    // rather thin disguise.
    expect(sealed).not.toContain(Buffer.from(code, 'utf8').toString('base64'));
  });

  it('will not open under a different key', () => {
    const sealed = sealVerificationCode(generateVerificationCode(), key);
    expect(openVerificationCode(sealed, randomBytes(32))).toBeNull();
  });

  it('will not open a tampered envelope', () => {
    // GCM refuses rather than returning attacker-chosen plaintext.
    const code = generateVerificationCode();
    const envelope = JSON.parse(sealVerificationCode(code, key)) as { ciphertext: string };
    const flipped = Buffer.from(envelope.ciphertext, 'base64');
    flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
    const tampered = JSON.stringify({
      ...JSON.parse(sealVerificationCode(code, key)),
      ciphertext: flipped.toString('base64'),
    });
    expect(openVerificationCode(tampered, key)).toBeNull();
  });

  it('treats an erased or unreadable value as no code at all', () => {
    expect(openVerificationCode(null, key)).toBeNull();
    expect(openVerificationCode('', key)).toBeNull();
    expect(openVerificationCode('not json', key)).toBeNull();
    expect(openVerificationCode(JSON.stringify({ v: 99 }), key)).toBeNull();
  });
});
