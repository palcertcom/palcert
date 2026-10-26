'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { NotificationBell } from '@/components/notification-bell';
import { Icon } from '@/components/ui/icon';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { breadcrumbsFor } from '@/lib/breadcrumbs';
import { buildNavigation, organizationIdFromPath } from '@/lib/shell-navigation';
import { AccountMenu } from './account-menu';
import { Breadcrumbs } from './breadcrumbs';
import { Wave } from './decor';
import { LocaleSwitcher } from './locale-switcher';
import { useShell } from './shell-context';
import { Brand, Sidebar } from './sidebar';

/**
 * The application frame: sidebar, topbar, breadcrumb, then the page.
 *
 * Pages render their own `<main>`; the frame wraps it rather than replacing
 * it, so no page had to change to move into the new shell. The skip link
 * targets the wrapper.
 */
export function AppShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  const m = getShellMessages(locale);
  const pathname = usePathname() ?? `/${locale}`;
  const shell = useShell();
  const sidebarId = useId();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A new page closes the drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeDrawer();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  function closeDrawer(): void {
    setDrawerOpen(false);
    toggleRef.current?.focus();
  }

  const groups = useMemo(
    () =>
      buildNavigation({
        locale,
        globalPermissions: shell.globalPermissions,
        organizationId: shell.currentOrganization?.organization.id ?? null,
        organizationPermissions: shell.organizationPermissions,
        unreadNotifications: shell.unreadNotifications,
      }),
    [
      locale,
      shell.globalPermissions,
      shell.currentOrganization,
      shell.organizationPermissions,
      shell.unreadNotifications,
    ],
  );

  const routeOrganizationId = organizationIdFromPath(pathname);
  const routeOrganization =
    routeOrganizationId === null
      ? null
      : (shell.organizations.find((entry) => entry.organization.id === routeOrganizationId) ??
        null);
  const crumbs = breadcrumbsFor(
    pathname,
    locale,
    routeOrganization?.organization.displayName ?? null,
  );

  const signedIn = shell.status === 'signed-in' && shell.user !== null;
  const signedOut = shell.status === 'signed-out';

  // Every part of the frame is a direct child of <body>, and so is the page.
  //
  // Not a wrapper element around the page, deliberately. A page's code arrives
  // in its own script and on a slow start is not ready when React begins
  // hydrating; inside an ordinary element React then finds the page's server
  // HTML unclaimed and throws the whole document away (React #418, measured at
  // 1–7 % of loads). Directly under <body> React waits for it instead — which
  // is also where the page sat before the redesign, and why it never failed
  // there. A Suspense boundary around the page would avoid it too, but would
  // turn every "page not found" into a 200. The layout is a CSS grid on
  // <body> (shell.css).
  return (
    <>
      <a className="pc-skip-link" href="#pc-content">
        {m.skipToContent}
      </a>

      {signedOut ? null : (
        <>
          <div className="pc-app-rail" data-open={drawerOpen ? 'true' : 'false'}>
            <Sidebar
              id={sidebarId}
              locale={locale}
              pathname={pathname}
              groups={signedIn ? groups : []}
              organizations={shell.organizations}
              currentOrganization={shell.currentOrganization}
              drawerOpen={drawerOpen}
              onClose={closeDrawer}
              closeRef={closeRef}
            />
          </div>
          <div
            className="pc-drawer-backdrop"
            data-open={drawerOpen ? 'true' : 'false'}
            onClick={closeDrawer}
            aria-hidden="true"
          />
        </>
      )}

      <header className="pc-app-topbar" data-signed-out={signedOut ? 'true' : undefined}>
        <div className="pc-topbar-context">
          {signedOut ? null : (
            <button
              ref={toggleRef}
              type="button"
              className="pc-icon-button pc-menu-toggle"
              aria-expanded={drawerOpen}
              aria-controls={sidebarId}
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" />
              <span className="pc-visually-hidden">{m.openNavigation}</span>
            </button>
          )}
          <span className="pc-topbar-brand">
            <Brand locale={locale} />
          </span>
          {routeOrganization !== null ? (
            <p className="pc-topbar-title" dir="auto">
              {routeOrganization.organization.displayName}
            </p>
          ) : null}
        </div>

        <div className="pc-topbar-actions">
          <LocaleSwitcher locale={locale} />
          {signedIn ? (
            <>
              <NotificationBell
                key={shell.user!.id}
                locale={locale}
                onCountChange={shell.setUnreadNotifications}
                current={pathname === `/${locale}/notifications`}
              />
              <AccountMenu
                locale={locale}
                user={shell.user!}
                canReadProfile={shell.globalPermissions.has('profile:read:self')}
                canReadSessions={shell.globalPermissions.has('session:read:self')}
                onSignedOut={shell.reload}
              />
            </>
          ) : null}
          {signedOut ? (
            <>
              <Link className="pc-btn pc-btn-secondary pc-btn-sm" href={`/${locale}/register`}>
                {m.createAccount}
              </Link>
              <Link className="pc-btn pc-btn-sm" href={`/${locale}/login`}>
                {m.signIn}
              </Link>
            </>
          ) : null}
        </div>
      </header>

      {/* Where "skip to main content" lands: the start of the page area. */}
      <div id="pc-content" className="pc-app-context" tabIndex={-1}>
        <Breadcrumbs crumbs={crumbs} label={m.breadcrumbs} />
      </div>
      {children}
      <Wave />
    </>
  );
}
