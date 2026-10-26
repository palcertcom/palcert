import { describe, expect, it } from 'vitest';
import { AUTH_MESSAGES, getAuthMessages, messageForErrorCode } from './auth-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

describe('auth message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(AUTH_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(AUTH_MESSAGES[locale]).sort(), `locale ${locale}`).toEqual(reference);
    }
  });

  it('defines every error code in every locale', () => {
    const reference = Object.keys(AUTH_MESSAGES[DEFAULT_LOCALE].errors).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(AUTH_MESSAGES[locale].errors).sort(), `locale ${locale}`).toEqual(
        reference,
      );
    }
  });

  it('has no empty strings', () => {
    for (const locale of LOCALES) {
      const messages = AUTH_MESSAGES[locale];
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value === 'string') {
          expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        }
      }
      for (const [code, value] of Object.entries(messages.errors)) {
        expect(value.trim().length, `${locale}.errors.${code}`).toBeGreaterThan(0);
      }
    }
  });

  it('actually translates Arabic rather than shipping English', () => {
    const { en, ar } = AUTH_MESSAGES;

    for (const [key, value] of Object.entries(ar)) {
      if (typeof value !== 'string') continue;
      expect(value, `ar.${key} is untranslated`).not.toBe(en[key as keyof typeof en]);
      expect(value, `ar.${key} contains no Arabic`).toMatch(ARABIC_SCRIPT);
    }
  });

  it('translates every Arabic error message', () => {
    for (const [code, value] of Object.entries(AUTH_MESSAGES.ar.errors)) {
      expect(value, `ar.errors.${code}`).not.toBe(AUTH_MESSAGES.en.errors[code]);
      expect(value, `ar.errors.${code}`).toMatch(ARABIC_SCRIPT);
    }
  });

  it('covers every error code the API can return for an auth flow', () => {
    // Kept in step with packages/contracts deliberately: a new user-facing code
    // must be localized before it can reach a screen.
    const expected = [
      'AUTHENTICATION_FAILED',
      'EMAIL_NOT_VERIFIED',
      'ACCOUNT_SUSPENDED',
      'ACCOUNT_DISABLED',
      'SESSION_EXPIRED',
      'SESSION_REVOKED',
      'VERIFICATION_TOKEN_INVALID',
      'VERIFICATION_TOKEN_EXPIRED',
      'PASSWORD_RESET_TOKEN_INVALID',
      'PASSWORD_RESET_TOKEN_EXPIRED',
      'PASSWORD_POLICY_VIOLATION',
      'MFA_REQUIRED',
      'MFA_INVALID',
      'MFA_ENROLLMENT_REQUIRED',
      'PERMISSION_DENIED',
      'RATE_LIMITED',
      'CSRF_INVALID',
    ];

    for (const code of expected) {
      for (const locale of LOCALES) {
        expect(AUTH_MESSAGES[locale].errors[code], `${locale}.${code}`).toBeDefined();
      }
    }
  });

  it('never leaks a raw error code to the user', () => {
    for (const locale of LOCALES) {
      const messages = AUTH_MESSAGES[locale];
      for (const [code, value] of Object.entries(messages.errors)) {
        expect(value, `${locale}.${code}`).not.toContain(code);
      }
    }
  });
});

describe('messageForErrorCode', () => {
  it('resolves a known code', () => {
    expect(messageForErrorCode(getAuthMessages('en'), 'MFA_INVALID')).toBe(
      AUTH_MESSAGES.en.errors.MFA_INVALID,
    );
    expect(messageForErrorCode(getAuthMessages('ar'), 'MFA_INVALID')).toBe(
      AUTH_MESSAGES.ar.errors.MFA_INVALID,
    );
  });

  it('falls back to a safe generic message for an unknown or missing code', () => {
    const messages = getAuthMessages('ar');
    expect(messageForErrorCode(messages, 'SOME_FUTURE_CODE')).toBe(messages.genericError);
    expect(messageForErrorCode(messages, undefined)).toBe(messages.genericError);
  });

  it('never surfaces an internal code as prose', () => {
    expect(messageForErrorCode(getAuthMessages('en'), 'INTERNAL_ERROR')).toBe(
      AUTH_MESSAGES.en.genericError,
    );
  });
});
