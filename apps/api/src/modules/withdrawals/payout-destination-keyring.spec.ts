import { AppError, PalCertErrorCode } from '@palcert/contracts';
import type { ApiConfigService } from '../../config/api-config.service';
import {
  EmailSecretKeyring,
  EmailSecretPurpose,
} from '../../infrastructure/email/email-secret-keyring';
import {
  PayoutDestinationKeyring,
  PayoutSealAuthenticationError,
  PayoutSealPurpose,
} from './payout-destination-keyring';

const key = (fill: number) => Buffer.alloc(32, fill);
const ring = (keys: string, activeKid: string) =>
  new PayoutDestinationKeyring({
    payoutDestinationEncryption: { activeKid, keys },
  } as unknown as ApiConfigService);
const details = {
  bankName: 'Bank of Palestine',
  iban: 'GB82WEST12345698765432',
  accountNumber: null,
  branch: 'Ramallah',
  mobileNumber: null,
  instructions: null,
};

describe('PayoutDestinationKeyring (ADR-0150, D7)', () => {
  const keyring = ring(`p1:${key(1).toString('base64')},p2:${key(2).toString('base64')}`, 'p2');
  const binding = { purpose: PayoutSealPurpose.DESTINATION, recordId: 'destination-1' };

  it('seals under the active key and opens to the same details, never storing them in the clear', () => {
    const sealed = keyring.seal(details, binding);
    expect(sealed.kid).toBe('p2');
    expect(sealed.ciphertext).not.toContain('GB82');
    expect(keyring.open(sealed, binding)).toEqual(details);
  });

  it('opens material sealed under a retired key that is still held (rotation)', () => {
    const old = ring(`p1:${key(1).toString('base64')}`, 'p1').seal(details, binding);
    expect(keyring.open(old, binding)).toEqual(details);
  });

  it('refuses material copied onto another row or relabelled as a request snapshot', () => {
    const sealed = keyring.seal(details, binding);
    expect(() => keyring.open(sealed, { ...binding, recordId: 'destination-2' })).toThrow(
      PayoutSealAuthenticationError,
    );
    expect(() =>
      keyring.open(sealed, {
        purpose: PayoutSealPurpose.REQUEST_SNAPSHOT,
        recordId: 'destination-1',
      }),
    ).toThrow(PayoutSealAuthenticationError);
  });

  it('never opens as an email secret, even under the very same key', () => {
    const sealed = keyring.seal(details, binding);
    const email = new EmailSecretKeyring([{ kid: 'p2', key: key(2) }], 'p2');
    expect(() =>
      email.open(sealed, { purpose: EmailSecretPurpose.API_KEY, provider: 'resend' }),
    ).toThrow();
  });

  it('refuses to seal or open when no payout key ring is configured', () => {
    const none = new PayoutDestinationKeyring({
      payoutDestinationEncryption: null,
    } as unknown as ApiConfigService);
    expect(none.available).toBe(false);
    try {
      none.seal(details, binding);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(
        PalCertErrorCode.PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE,
      );
    }
  });
});
