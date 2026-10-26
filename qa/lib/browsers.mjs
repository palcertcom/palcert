/**
 * The engine, locale and viewport matrix (Phase 20 Checkpoint 8).
 *
 * Three engines because PalCert's users do not all use one, and because the
 * three differ in exactly the places this release touches: focus behaviour in
 * dialogs, form validation defaults, and bidirectional text.
 *
 * The widths are device classes rather than device names. A phone at 390 and a
 * desktop at 1920 are different layouts; a "Pixel 7" and a "Galaxy S23" are the
 * same one.
 */
import { chromium, firefox, webkit } from 'playwright';

export const ENGINES = {
  chromium: {
    type: chromium,
    // Optional. Playwright's own download is used unless a path is given —
    // which is only needed where the installed Chromium is a different
    // revision from the one this Playwright version expects.
    launch: {
      ...(process.env.CHROME_PATH === undefined ? {} : { executablePath: process.env.CHROME_PATH }),
      args: ['--ignore-certificate-errors'],
    },
  },
  firefox: { type: firefox, launch: {} },
  webkit: { type: webkit, launch: {} },
};

export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  laptop: { width: 1280, height: 800 },
  desktop: { width: 1920, height: 1080 },
};

export const LOCALES = {
  en: { direction: 'ltr', acceptLanguage: 'en-GB,en;q=0.9' },
  ar: { direction: 'rtl', acceptLanguage: 'ar,en;q=0.5' },
};

export function selectedEngines() {
  const requested = (process.env.BROWSERS ?? 'chromium,firefox,webkit').split(',');
  return requested.map((name) => name.trim()).filter((name) => name in ENGINES);
}

export function selectedViewports() {
  const requested = (process.env.VIEWPORTS ?? 'phone,tablet,laptop,desktop').split(',');
  return requested.map((name) => name.trim()).filter((name) => name in VIEWPORTS);
}

export function selectedLocales() {
  const requested = (process.env.LOCALES ?? 'en,ar').split(',');
  return requested.map((name) => name.trim()).filter((name) => name in LOCALES);
}
