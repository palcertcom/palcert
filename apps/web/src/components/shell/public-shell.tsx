'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { LocaleSwitcher } from './locale-switcher';
import { useShell } from './shell-context';
import { Brand } from './sidebar';
import { Wave } from './decor';

/**
 * Pages anyone may open — certificate verification, and the pages that say
 * someone may not open something. No account navigation: a verifier is not a
 * PalCert user, and nothing here should suggest they need to become one.
 */
export function PublicShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  const m = getShellMessages(locale);
  const { status } = useShell();

  // Frame parts and the page are all direct children of <body>, for the reason
  // given in app-shell.tsx; the layout is a grid on <body> (shell.css).
  return (
    <>
      <a className="pc-skip-link" href="#pc-content">
        {m.skipToContent}
      </a>
      <header className="pc-auth-header pc-frame-public">
        <Brand locale={locale} />
        <div className="pc-topbar-actions">
          <LocaleSwitcher locale={locale} />
          {status === 'signed-in' ? (
            <Link className="pc-btn pc-btn-secondary pc-btn-sm" href={`/${locale}`}>
              {m.dashboard}
            </Link>
          ) : status === 'signed-out' ? (
            <Link className="pc-btn pc-btn-secondary pc-btn-sm" href={`/${locale}/login`}>
              {m.signIn}
            </Link>
          ) : null}
        </div>
      </header>
      <span id="pc-content" className="pc-content-anchor" tabIndex={-1} />
      {children}
      <Wave />
    </>
  );
}
