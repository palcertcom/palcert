'use client';

import { useRouter } from 'next/navigation';
import { useId } from 'react';
import type { UserOrganizationResponse } from '@/lib/api-client';
import { labelFor, type OrganizationMessages } from '@/i18n/organization-messages';
import type { Locale } from '@/i18n/locales';

/**
 * Organization switcher (§54).
 *
 * A native `<select>`, deliberately: it is keyboard-operable, screen-reader
 * announced and correctly mirrored in RTL on every platform, none of which a
 * custom dropdown gets for free.
 *
 * Switching only changes which organization the UI is looking at. It grants
 * nothing: every request still names the organization in its path and is
 * re-authorized server-side, so a user who edits this control simply receives
 * 404s for organizations they do not belong to.
 */
export function OrganizationSwitcher({
  organizations,
  currentId,
  locale,
  messages,
}: {
  organizations: UserOrganizationResponse[];
  currentId: string;
  locale: Locale;
  messages: OrganizationMessages;
}) {
  const router = useRouter();
  const id = useId();

  if (organizations.length === 0) return null;

  return (
    <div className="pc-field pc-switcher">
      <label htmlFor={id}>{messages.switchOrganization}</label>
      {/* `dir="auto"` sets each name in its own direction, so a Latin name in
          the Arabic interface is cut at its end, not its beginning. */}
      <select
        id={id}
        dir="auto"
        value={currentId}
        onChange={(event) => router.push(`/${locale}/organizations/${event.target.value}`)}
      >
        {organizations.map((entry) => (
          <option key={entry.organization.id} value={entry.organization.id}>
            {entry.organization.displayName}
            {entry.membershipStatus !== 'ACTIVE'
              ? ` — ${labelFor(messages.statusLabels, entry.membershipStatus)}`
              : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
