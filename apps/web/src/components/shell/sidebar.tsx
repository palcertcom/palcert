'use client';

import Link from 'next/link';
import { type KeyboardEvent, type RefObject } from 'react';
import { OrganizationSwitcher } from '@/components/organization-switcher';
import { BrandMark, Icon } from '@/components/ui/icon';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import type { UserOrganizationResponse } from '@/lib/api-client';
import { isActive, type NavGroup } from '@/lib/shell-navigation';

export function Brand({ locale }: { locale: Locale }) {
  const m = getShellMessages(locale);
  return (
    <Link href={`/${locale}`} className="pc-brand">
      <BrandMark />
      <span className="pc-brand-text">
        <span>{m.brand}</span>
        <span className="pc-brand-tagline">{m.brandTagline}</span>
      </span>
    </Link>
  );
}

/**
 * Which organization the sidebar is showing, and a way to change it.
 *
 * Changing it only changes where the reader is looking; every request still
 * names its organization and is authorized by the API.
 */
function OrganizationContext({
  locale,
  organizations,
  current,
}: {
  locale: Locale;
  organizations: readonly UserOrganizationResponse[];
  current: UserOrganizationResponse;
}) {
  const m = getShellMessages(locale);
  return (
    <div className="pc-org-context">
      <OrganizationSwitcher
        organizations={[...organizations]}
        currentId={current.organization.id}
        locale={locale}
        messages={getOrganizationMessages(locale)}
      />
      <div className="pc-org-context-links">
        <Link href={`/${locale}/organizations`}>{m.allOrganizations}</Link>
      </div>
    </div>
  );
}

export function Sidebar({
  id,
  locale,
  pathname,
  groups,
  organizations,
  currentOrganization,
  drawerOpen,
  onClose,
  closeRef,
}: {
  id: string;
  locale: Locale;
  pathname: string;
  groups: readonly NavGroup[];
  organizations: readonly UserOrganizationResponse[];
  currentOrganization: UserOrganizationResponse | null;
  drawerOpen: boolean;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  const m = getShellMessages(locale);

  // While the drawer is open on a small screen, Tab stays inside it.
  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (!drawerOpen) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('a[href], button, select'),
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    // A plain container, not a landmark: the <nav> inside is the landmark,
    // and two landmarks with one name would only confuse a screen reader.
    <div id={id} className="pc-app-sidebar" onKeyDown={onKeyDown}>
      <button
        ref={closeRef}
        type="button"
        className="pc-icon-button pc-drawer-close"
        onClick={onClose}
        aria-label={m.closeNavigation}
      >
        <Icon name="close" />
      </button>
      <Brand locale={locale} />

      {currentOrganization !== null ? (
        <OrganizationContext
          locale={locale}
          organizations={organizations}
          current={currentOrganization}
        />
      ) : null}

      <nav className="pc-nav" aria-label={m.primaryNavigation}>
        {groups.map((group) => {
          const headingId = `${id}-${group.id}`;
          return (
            <div
              key={group.id}
              className="pc-nav-group"
              role={group.label === null ? undefined : 'group'}
              aria-labelledby={group.label === null ? undefined : headingId}
            >
              {group.label !== null ? <h2 id={headingId}>{group.label}</h2> : null}
              <ul>
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="pc-nav-link"
                      aria-current={isActive(item, pathname) ? 'page' : undefined}
                    >
                      <Icon name={item.icon} />
                      <span className="pc-nav-label">{item.label}</span>
                      {item.badge !== undefined ? (
                        <span className="pc-nav-badge">
                          <span aria-hidden="true">{item.badge}</span>
                          <span className="pc-visually-hidden">
                            {m.unreadNotifications(item.badge)}
                          </span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
