'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { SystemMessage } from '@/components/ui/system-message';
import { getFallbackMessages, localeFromPathname } from '@/i18n/fallback-messages';

/**
 * The boundary for a render that threw (Phase 20 Checkpoint 8, F-010).
 *
 * Without it, a client-side render failure falls through to Next's built-in
 * screen, which is untranslated and worded for whoever built the site. What a
 * person needs here is three things in their own language: that PalCert knows,
 * that their work is intact, and a way forward — `reset` re-renders the
 * segment, which is enough for a transient failure, and the link is the way
 * out when it is not.
 *
 * `error.message` is deliberately not shown. In a production build it is
 * already redacted to a digest, and a digest on screen is the machine contract
 * leaking into a human one. It goes to the console, where an operator asked
 * for a report can find it.
 */
export default function LocaleError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  const locale = localeFromPathname(usePathname());
  const messages = getFallbackMessages(locale);

  useEffect(() => {
    console.error('PalCert render failure', error.digest ?? error.message);
  }, [error]);

  return (
    <SystemMessage
      icon="close"
      title={messages.errorTitle}
      body={messages.errorBody}
      alert
      actions={
        <>
          <button type="button" className="pc-btn" onClick={reset}>
            {messages.retry}
          </button>
          <Link className="pc-btn pc-btn-secondary" href={`/${locale}`}>
            {messages.home}
          </Link>
        </>
      }
    />
  );
}
