import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { AuthArtwork } from './auth-artwork';
import { Wave } from './decor';
import { LocaleSwitcher } from './locale-switcher';
import { Brand } from './sidebar';

/**
 * The frame around signing in, registering, and the other account steps.
 *
 * Sign-in and registration get the split layout of the original design (form
 * on one side, the illustration and the way to the other page on the other);
 * the smaller steps — MFA, password reset, email verification, invitations —
 * get the form alone, centred, with the same header and wave.
 */
export function AuthShell({
  locale,
  variant,
  children,
}: {
  locale: Locale;
  variant: 'sign-in' | 'register' | 'card';
  children: ReactNode;
}) {
  const m = getShellMessages(locale);
  const split = variant !== 'card';

  // Frame parts and the page are all direct children of <body>, for the reason
  // given in app-shell.tsx; the layout is a grid on <body> (shell.css).
  return (
    <>
      <a className="pc-skip-link" href="#pc-content">
        {m.skipToContent}
      </a>
      <header className="pc-auth-header pc-frame-auth" data-variant={split ? 'split' : 'card'}>
        <Brand locale={locale} />
        <LocaleSwitcher locale={locale} />
      </header>
      {split ? <div className="pc-lattice" aria-hidden="true" /> : null}
      <span id="pc-content" className="pc-content-anchor" tabIndex={-1} />
      {children}
      {split ? (
        <div className="pc-auth-aside">
          <AuthArtwork label={m.auth.artworkLabel} />
          <div className="pc-auth-invite">
            {variant === 'sign-in' ? (
              <>
                <p>{m.auth.noAccount}</p>
                <Link href={`/${locale}/register`}>
                  {m.auth.createNewAccount}
                  <Icon name="arrow" size={26} />
                </Link>
              </>
            ) : (
              <>
                <p>{m.auth.haveAccount}</p>
                <Link href={`/${locale}/login`}>
                  {m.signIn}
                  <Icon name="arrow" size={26} />
                </Link>
              </>
            )}
          </div>
        </div>
      ) : null}
      <Wave />
    </>
  );
}
