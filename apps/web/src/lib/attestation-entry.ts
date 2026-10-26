import type { Locale } from '@/i18n/locales';

/**
 * Where the public pages send someone who wants to use a signed-in feature.
 *
 * Signed in: straight to the existing workflow. Signed out: to the sign-in
 * page with `next`, the convention every other "sign in to continue" link
 * uses (lib/return-path.ts accepts these paths). There is no second
 * attestation workflow — both targets are the authenticated pages.
 */
export function signInThen(locale: Locale, path: string): string {
  return `/${locale}/login?next=${encodeURIComponent(path)}`;
}

export interface AttestationEntry {
  /** Start a request: the attestation wizard. */
  readonly request: string;
  /** The person's own requests. */
  readonly mine: string;
  /** Start a document check. */
  readonly check: string;
}

export function attestationEntry(locale: Locale, signedIn: boolean): AttestationEntry {
  const target = (path: string) => (signedIn ? path : signInThen(locale, path));
  return {
    request: target(`/${locale}/attestations/new`),
    mine: target(`/${locale}/attestations`),
    check: target(`/${locale}/checks/new`),
  };
}
