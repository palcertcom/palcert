import { DEFAULT_LOCALE, isLocale, type Locale } from './locales';

/**
 * The two screens nobody designs for: a URL that does not exist, and a render
 * that threw (Phase 20 Checkpoint 8, finding F-010).
 *
 * Until now the only `not-found.tsx` sat outside the `[locale]` segment, so an
 * Arabic reader who mistyped a URL met an English, left-to-right page — the
 * one moment they are already lost is the one moment PalCert stopped speaking
 * their language. There was no error boundary at all, which left a render
 * failure to Next's built-in screen: untranslated, and worded for whoever
 * built the site rather than whoever is using it.
 *
 * Both boundaries render before any data is fetched and must never depend on
 * one, so their strings live here rather than in a feature catalogue.
 */
export interface FallbackMessages {
  readonly notFoundTitle: string;
  readonly notFoundBody: string;
  readonly errorTitle: string;
  readonly errorBody: string;
  readonly retry: string;
  readonly home: string;
}

export const FALLBACK_MESSAGES: Record<Locale, FallbackMessages> = {
  en: {
    notFoundTitle: 'This page does not exist',
    notFoundBody:
      'The address may have been mistyped, or the page may have been moved. Your documents and certificates are unaffected.',
    errorTitle: 'Something went wrong on this screen',
    errorBody:
      'Nothing you have done has been lost. Try again, and if this keeps happening, go back to the start.',
    retry: 'Try again',
    home: 'Back to PalCert',
  },
  ar: {
    notFoundTitle: 'هذه الصفحة غير موجودة',
    notFoundBody:
      'قد يكون العنوان مكتوباً بشكل خاطئ، أو قد تكون الصفحة قد نُقلت. مستنداتك وشهاداتك لم تتأثر.',
    errorTitle: 'حدث خطأ في هذه الشاشة',
    errorBody: 'لم يُفقد أي شيء قمت به. حاول مرة أخرى، وإذا تكرر هذا فعد إلى البداية.',
    retry: 'حاول مرة أخرى',
    home: 'العودة إلى بال‌سيرت',
  },
};

export function getFallbackMessages(locale: Locale): FallbackMessages {
  return FALLBACK_MESSAGES[locale] ?? FALLBACK_MESSAGES[DEFAULT_LOCALE];
}

/**
 * The locale from the address bar.
 *
 * Neither boundary is given route params: `not-found` is reached precisely
 * because no route matched, and `error` replaces the segment that would have
 * supplied them. The path is the only thing left that knows.
 */
export function localeFromPathname(pathname: string | null | undefined): Locale {
  const first = (pathname ?? '').split('/').filter((part) => part.length > 0)[0];
  return isLocale(first) ? first : DEFAULT_LOCALE;
}
