'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { pathInLocale } from '@/lib/shell-navigation';

/**
 * Switch to the same page in the other language.
 *
 * A plain link, so it works before scripts load and needs no state of its
 * own. The query string is carried across after mount: a reset or invitation
 * link has its token there, and changing language must not lose it.
 */
export function LocaleSwitcher({ locale }: { locale: Locale }) {
  const pathname = usePathname() ?? `/${locale}`;
  const [search, setSearch] = useState('');
  const m = getShellMessages(locale);

  useEffect(() => {
    setSearch(window.location.search);
  }, [pathname]);

  const others = LOCALES.filter((candidate) => candidate !== locale);

  return (
    <nav className="pc-locale-switch" aria-label={m.language}>
      {others.map((candidate) => (
        <a
          key={candidate}
          href={`${pathInLocale(pathname, candidate)}${search}`}
          hrefLang={candidate}
          lang={candidate}
        >
          <Icon name="globe" size={18} />
          <span className="pc-locale-label">{LOCALE_LABELS[candidate]}</span>
          <span className="pc-visually-hidden" lang={locale}>
            {` (${m.language})`}
          </span>
        </a>
      ))}
    </nav>
  );
}
