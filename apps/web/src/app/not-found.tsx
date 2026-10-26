import Link from 'next/link';
import { DEFAULT_LOCALE, directionFor } from '@/i18n/locales';
import { getMessages } from '@/i18n/messages';
import '../styles/app.css';

/**
 * Root-level 404.
 *
 * The `[locale]` layout owns `<html>` for every real page, so the root layout
 * renders its children unchanged. Next.js still prerenders a global not-found
 * page outside that segment, which therefore has to supply its own document
 * shell. It falls back to the default locale because no locale segment matched.
 */
export default function NotFound() {
  const messages = getMessages(DEFAULT_LOCALE);

  return (
    <html lang={DEFAULT_LOCALE} dir={directionFor(DEFAULT_LOCALE)}>
      <body>
        <main className="pc-page pc-system-page">
          <h1 className="pc-title">404</h1>
          <p className="pc-tagline">This page could not be found.</p>
          <p>
            <Link href={`/${DEFAULT_LOCALE}`}>{messages.appName}</Link>
          </p>
        </main>
      </body>
    </html>
  );
}
