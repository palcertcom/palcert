'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SystemMessage } from '@/components/ui/system-message';
import { getFallbackMessages, localeFromPathname } from '@/i18n/fallback-messages';

/**
 * 404 inside the locale segment (Phase 20 Checkpoint 8, F-010).
 *
 * The `[locale]` layout already owns `<html lang>` and `dir`, so this only has
 * to supply words in the right language. The root `not-found.tsx` stays for
 * addresses with no locale at all, where there is nothing to translate into.
 */
export default function LocaleNotFound() {
  const locale = localeFromPathname(usePathname());
  const messages = getFallbackMessages(locale);

  return (
    <SystemMessage
      icon="document"
      title={messages.notFoundTitle}
      body={messages.notFoundBody}
      actions={
        <Link className="pc-btn" href={`/${locale}`}>
          {messages.home}
        </Link>
      }
    />
  );
}
