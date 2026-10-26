'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/locales';
import { routeKind } from '@/lib/shell-navigation';
import { AppShell } from './app-shell';
import { AuthShell } from './auth-shell';
import { PublicShell } from './public-shell';
import { useShell } from './shell-context';

/** Chooses the frame for the current route; the pages stay where they are. */
export function AppFrame({ locale, children }: { locale: Locale; children: ReactNode }) {
  const pathname = usePathname() ?? `/${locale}`;
  const kind = routeKind(pathname);
  const { status } = useShell();

  // The homepage draws its own public frame (header, footer) so that it can
  // be rendered on the server; the application frame takes over only once
  // the session is known to be signed in and the page is the dashboard.
  if (pathname === `/${locale}` && status !== 'signed-in') return <>{children}</>;

  if (kind === 'auth') {
    const rest = pathname.replace(/^\/[a-z]{2}/, '');
    const variant = rest.startsWith('/login')
      ? 'sign-in'
      : rest.startsWith('/register')
        ? 'register'
        : 'card';
    return (
      <AuthShell locale={locale} variant={variant}>
        {children}
      </AuthShell>
    );
  }
  if (kind === 'public') return <PublicShell locale={locale}>{children}</PublicShell>;
  return <AppShell locale={locale}>{children}</AppShell>;
}
