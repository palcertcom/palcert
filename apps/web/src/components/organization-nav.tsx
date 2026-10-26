'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { OrganizationMessages } from '@/i18n/organization-messages';
import type { Locale } from '@/i18n/locales';
import { organizationSections } from '@/lib/organization-sections';

/**
 * Dashboard navigation (§53).
 *
 * The sections themselves are defined once, in `organizationSections`.
 */
export function OrganizationNav({
  locale,
  organizationId,
  messages,
  permissions,
}: {
  locale: Locale;
  organizationId: string;
  messages: OrganizationMessages;
  permissions: ReadonlySet<string>;
}) {
  const pathname = usePathname();
  // One definition shared with the sidebar; filtered by the caller's permissions.
  const sections = organizationSections(locale, organizationId, permissions);

  return (
    <nav className="pc-org-nav" aria-label={messages.organizations}>
      <ul>
        {sections.map((section) => {
          const active = pathname === section.href;
          return (
            <li key={section.href}>
              <Link href={section.href} aria-current={active ? 'page' : undefined}>
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
