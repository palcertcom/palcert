import {
  ATTESTATION_REQUEST_EVENT_TYPES,
  ATTESTATION_REQUEST_STATUSES,
  ATTESTATION_VERIFICATION_STATUSES,
  AttestationArtifactStatus,
  AttestationPaymentStatus,
  CONFIGURABLE_REQUIRED_FIELDS,
  PalCertErrorCode,
} from '@palcert/contracts';
import { describe, expect, it } from 'vitest';
import { ATTESTATIONS_MESSAGES, getAttestationsMessages } from './attestations-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Values that are deliberately the same in both languages. */
const NOT_PROSE = new Set(['none']);

/** PalCert's plumbing, which nobody reading an attestation should meet. */
const INTERNAL_TERMS =
  /\bRLS\b|\brow[- ]level security\b|\bSECURITY DEFINER\b|\bs3\b|\bbucket\b|\bobject key\b|\bidempotency\b|\bprisma\b|\bsigned url\b|\bjob\b|\bledger\b/i;

/** One balance, never a second one (the spec's "no second wallet"). */
const SECOND_WALLET = /\bwallet\b|\bcredits?\b|محفظة/i;

function flatten(messages: object, prefix = ''): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    const path = `${prefix}${key}`;
    if (typeof value === 'string') entries.push([path, value]);
    else if (typeof value === 'function')
      entries.push([path, String((value as (...args: unknown[]) => unknown)(2, 5))]);
    else if (Array.isArray(value))
      value.forEach((item, index) => entries.push([`${path}.${index}`, String(item)]));
    else if (value !== null && typeof value === 'object')
      entries.push(...flatten(value as object, `${path}.`));
  }
  return entries;
}

describe('Attestation message catalogue', () => {
  it('defines every label at every depth in every locale', () => {
    const reference = flatten(ATTESTATIONS_MESSAGES[DEFAULT_LOCALE])
      .map(([key]) => key)
      .sort();
    for (const locale of LOCALES) {
      expect(
        flatten(ATTESTATIONS_MESSAGES[locale])
          .map(([key]) => key)
          .sort(),
      ).toEqual(reference);
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(ATTESTATIONS_MESSAGES.ar)) {
      if (NOT_PROSE.has(key)) continue;
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('names every state the API can report', () => {
    for (const locale of LOCALES) {
      const m = getAttestationsMessages(locale);
      for (const status of ATTESTATION_REQUEST_STATUSES)
        expect([locale, status, m.statuses[status]]).not.toContain(undefined);
      for (const status of ATTESTATION_VERIFICATION_STATUSES) {
        expect([
          locale,
          status,
          m.verificationStatuses[status],
          m.verificationHints[status],
        ]).not.toContain(undefined);
      }
      for (const status of Object.values(AttestationPaymentStatus)) {
        expect([locale, status, m.paymentStatuses[status]]).not.toContain(undefined);
      }
      for (const status of Object.values(AttestationArtifactStatus)) {
        expect([locale, status, m.artifactStatuses[status]]).not.toContain(undefined);
      }
      for (const type of ATTESTATION_REQUEST_EVENT_TYPES)
        expect([locale, type, m.eventTypes[type]]).not.toContain(undefined);
      for (const field of ['certificateTitle', ...CONFIGURABLE_REQUIRED_FIELDS]) {
        expect([locale, field, m.fields[field]]).not.toContain(undefined);
      }
    }
  });

  it('explains every attestation error the API can return', () => {
    const codes = Object.values(PalCertErrorCode).filter((code) => code.startsWith('ATTESTATION_'));
    expect(codes.length).toBeGreaterThan(10);
    for (const locale of LOCALES) {
      for (const code of [...codes, 'INSUFFICIENT_BALANCE']) {
        expect([locale, code, getAttestationsMessages(locale).errors[code]]).not.toContain(
          undefined,
        );
      }
    }
  });

  it('never claims PalCert issued the certificate', () => {
    expect(ATTESTATIONS_MESSAGES.en.disclaimer).toBe(
      'PalCert attests a submitted artifact. It does not imply PalCert originally issued that external certificate.',
    );
    expect(ATTESTATIONS_MESSAGES.ar.disclaimer).toContain('لا يعني');
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(ATTESTATIONS_MESSAGES[locale])) {
        if (key === 'disclaimer') continue;
        expect([locale, key, /PalCert (issued|certifies the degree)/i.test(value)]).toEqual([
          locale,
          key,
          false,
        ]);
      }
    }
  });

  it('keeps internal plumbing and a second balance out of the words', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(ATTESTATIONS_MESSAGES[locale])) {
        expect([locale, key, INTERNAL_TERMS.test(value)]).toEqual([locale, key, false]);
        expect([locale, key, SECOND_WALLET.test(value)]).toEqual([locale, key, false]);
      }
    }
  });

  it('tells the user the fee is reserved, charged on approval and returned on rejection', () => {
    expect(ATTESTATIONS_MESSAGES.en.wizard.reserveNote).toMatch(/held/);
    expect(ATTESTATIONS_MESSAGES.en.wizard.reserveNote).toMatch(
      /charged if the institution approves/,
    );
    expect(ATTESTATIONS_MESSAGES.en.wizard.reserveNote).toMatch(/returned in full/);
    expect(ATTESTATIONS_MESSAGES.en.wizard.refundPolicy).toMatch(/not refunded automatically/);
  });
});
