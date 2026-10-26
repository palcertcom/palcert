import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Verification pages are not content for a search index (§21).
 *
 * The API says so on its own response, but a crawler reaches the page, not
 * the API, so the page has to say it too. A certificate is something a holder
 * chose to show one person; a search result would make that choice for them.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function VerifyLayout({ children }: { children: ReactNode }) {
  return children;
}
