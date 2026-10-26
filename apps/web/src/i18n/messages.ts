import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * The product's name and one-line description, used for page metadata. The
 * shell and the home page have their own catalogue (`shell-messages`); each
 * feature module has its own.
 *
 * Every key MUST exist in every locale — enforced by the `Messages` type and
 * by a unit test, so a missing Arabic translation fails CI rather than
 * silently rendering English to an Arabic user.
 */
export interface Messages {
  readonly appName: string;
  readonly tagline: string;
  readonly workflow: string;
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    appName: 'PalCert',
    tagline: 'Document compliance, correction, verification and certification.',
    workflow: 'Define → Check → Fix → Verify → Approve → Certify',
  },
  ar: {
    appName: 'بال‌سيرت',
    tagline: 'فحص المستندات وتصحيحها والتحقق منها واعتمادها.',
    workflow: 'تحديد ← فحص ← تصحيح ← تحقق ← اعتماد ← شهادة',
  },
};

export function getMessages(locale: Locale): Messages {
  return MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
}
