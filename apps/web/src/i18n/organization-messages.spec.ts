import { describe, expect, it } from 'vitest';
import { ORGANIZATION_MESSAGES, getOrganizationMessages, labelFor } from './organization-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'typeLabels',
  'roleLabels',
  'statusLabels',
  'verificationLabels',
  'errors',
] as const;

describe('organization message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(ORGANIZATION_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(ORGANIZATION_MESSAGES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(ORGANIZATION_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(ORGANIZATION_MESSAGES[locale][map]).sort(), `${locale}.${map}`).toEqual(
          reference,
        );
      }
    }
  });

  it('has no empty strings anywhere', () => {
    for (const locale of LOCALES) {
      const messages = ORGANIZATION_MESSAGES[locale];
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value === 'string') {
          expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        } else {
          for (const [nested, nestedValue] of Object.entries(value as Record<string, string>)) {
            expect(nestedValue.trim().length, `${locale}.${key}.${nested}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('genuinely translates Arabic rather than shipping English', () => {
    const { en, ar } = ORGANIZATION_MESSAGES;

    for (const [key, value] of Object.entries(ar)) {
      if (typeof value !== 'string') continue;
      expect(value, `ar.${key} is untranslated`).not.toBe(en[key as keyof typeof en]);
      expect(value, `ar.${key} contains no Arabic`).toMatch(ARABIC_SCRIPT);
    }
  });

  it('translates every enum label into Arabic', () => {
    for (const map of NESTED_MAPS) {
      for (const [code, value] of Object.entries(ORGANIZATION_MESSAGES.ar[map])) {
        expect(value, `ar.${map}.${code}`).not.toBe(ORGANIZATION_MESSAGES.en[map][code]);
        expect(value, `ar.${map}.${code}`).toMatch(ARABIC_SCRIPT);
      }
    }
  });

  it('never leaks a canonical enum value into displayed prose', () => {
    // Enum values are the API contract; the UI must show translated labels.
    for (const locale of LOCALES) {
      const messages = ORGANIZATION_MESSAGES[locale];
      for (const [code, label] of Object.entries(messages.roleLabels)) {
        expect(label, `${locale}.${code}`).not.toContain(code);
      }
      for (const [code, label] of Object.entries(messages.typeLabels)) {
        expect(label, `${locale}.${code}`).not.toContain(code);
      }
    }
  });

  it('covers every organization type, role and lifecycle status', () => {
    const messages = ORGANIZATION_MESSAGES.en;

    for (const type of [
      'UNIVERSITY',
      'SCIENTIFIC_JOURNAL',
      'PUBLISHER',
      'RESEARCH_INSTITUTION',
      'GOVERNMENT',
      'COMPANY',
      'OTHER',
    ]) {
      expect(messages.typeLabels[type], type).toBeDefined();
    }

    for (const role of [
      'ORGANIZATION_OWNER',
      'ORGANIZATION_ADMIN',
      'ORGANIZATION_REVIEWER',
      'TEMPLATE_MANAGER',
    ]) {
      expect(messages.roleLabels[role], role).toBeDefined();
    }

    for (const status of [
      'ACTIVE',
      'SUSPENDED',
      'REMOVED',
      'CLOSED',
      'PENDING',
      'ACCEPTED',
      'REVOKED',
      'EXPIRED',
    ]) {
      expect(messages.statusLabels[status], status).toBeDefined();
    }

    for (const status of ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED']) {
      expect(messages.verificationLabels[status], status).toBeDefined();
    }
  });

  it('covers every tenant error code in both locales', () => {
    const codes = [
      'ORGANIZATION_NOT_FOUND',
      'ORGANIZATION_ACCESS_DENIED',
      'ORGANIZATION_SUSPENDED',
      'ORGANIZATION_SLUG_TAKEN',
      'MEMBERSHIP_SUSPENDED',
      'LAST_OWNER_REQUIRED',
      'INVITATION_EXPIRED',
      'INVITATION_REVOKED',
      'INVITATION_ALREADY_USED',
      'INVITATION_EMAIL_MISMATCH',
      'ROLE_SCOPE_INVALID',
    ];

    for (const code of codes) {
      for (const locale of LOCALES) {
        expect(ORGANIZATION_MESSAGES[locale].errors[code], `${locale}.${code}`).toBeDefined();
      }
    }
  });

  it('states what verification does NOT mean, in both locales', () => {
    // §27: the badge must never read as a claim about academic quality.
    expect(ORGANIZATION_MESSAGES.en.verificationSemantics).toContain('not an assessment');
    expect(ORGANIZATION_MESSAGES.ar.verificationSemantics).toContain('ليس');
  });
});

describe('labelFor', () => {
  it('translates a known value', () => {
    expect(labelFor(getOrganizationMessages('ar').roleLabels, 'ORGANIZATION_OWNER')).toBe('مالك');
  });

  it('falls back to the raw value for something it does not know', () => {
    // A role added by a later phase must render as something, not crash.
    expect(labelFor(getOrganizationMessages('en').roleLabels, 'FUTURE_ROLE')).toBe('FUTURE_ROLE');
  });

  it('renders an empty string for a missing value', () => {
    expect(labelFor(getOrganizationMessages('en').roleLabels, undefined)).toBe('');
  });
});
