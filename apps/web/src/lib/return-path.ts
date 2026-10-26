import type { Locale } from '@/i18n/locales';

/**
 * Where to go after signing in, if somewhere was asked for.
 *
 * Only a path inside this site and this language is accepted, and never a
 * sign-in page itself: anything else — another origin, a protocol-relative
 * `//host`, a backslash trick, a `javascript:` URL — is ignored and the
 * caller falls back to its default. An open redirect on the sign-in page
 * would turn PalCert's own login into a phishing tool.
 */
export function safeReturnPath(locale: Locale, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.length > 512) return null;
  if (!value.startsWith(`/${locale}/`)) return null;
  if (value.includes('//') || value.includes('\\')) return null;
  if (!/^[A-Za-z0-9/_\-.~%?=&]+$/.test(value)) return null;
  const rest = value.slice(locale.length + 1);
  if (/^\/(login|register|mfa|forgot-password|reset-password|verify-email)(\/|\?|$)/.test(rest)) {
    return null;
  }
  return value;
}
