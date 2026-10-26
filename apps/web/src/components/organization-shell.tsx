'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { FormError } from '@/components/auth-form';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/states';
import { VerificationBadge } from '@/components/verified-badge';
import { getAuthMessages } from '@/i18n/auth-messages';
import { resolveLocale, type Locale } from '@/i18n/locales';
import {
  getOrganizationMessages,
  labelFor,
  type OrganizationMessages,
} from '@/i18n/organization-messages';
import { permissionsForRoles } from '@/lib/organization-permissions';
import { ApiError, organizationApi, type OrganizationProfileResponse } from '@/lib/api-client';

export interface OrganizationShellState {
  readonly organizationId: string;
  readonly locale: Locale;
  readonly messages: OrganizationMessages;
  readonly organization: OrganizationProfileResponse;
  readonly permissions: ReadonlySet<string>;
  readonly reload: () => void;
}

/**
 * The organization dashboard shell (§53).
 *
 * Loads the organization and the caller's effective permissions once, then
 * renders the section. Permissions here drive which controls are shown — a
 * usability decision only; the backend authorizes every request regardless.
 */
export function OrganizationShell({
  children,
}: {
  children: (state: OrganizationShellState) => ReactNode;
}) {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : '';
  const messages = getOrganizationMessages(locale);
  const auth = getAuthMessages(locale);
  const router = useRouter();

  const [organization, setOrganization] = useState<OrganizationProfileResponse | null>(null);
  const [permissions, setPermissions] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [profile, organizations] = await Promise.all([
          organizationApi.get(organizationId),
          organizationApi.mine(),
        ]);
        if (cancelled) return;

        setOrganization(profile);

        // Derive the caller's effective permissions from the roles they hold in
        // *this* organization — never from any other.
        const entry = organizations.find((row) => row.organization.id === organizationId);
        setPermissions(permissionsForRoles(entry?.roles ?? []));
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/${locale}/unauthorized`);
          return;
        }
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? auth.genericError)
            : auth.genericError,
        );
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [auth, locale, messages, organizationId, reloadToken, router]);

  if (error !== null) {
    return (
      <main className="pc-page">
        <FormError message={error} />
      </main>
    );
  }

  if (organization === null) {
    return (
      <main className="pc-page">
        <LoadingState label={auth.sending} />
      </main>
    );
  }

  return (
    <main className="pc-page pc-org">
      {/* Whose workspace this is: the organization, whether PalCert has
          verified it, and what kind of institution it is. Each section below
          names itself in its own page title; the sections and the
          organization switcher live in the application sidebar. */}
      <p className="pc-org-identity">
        <Icon name="organization" size={18} />
        <bdi className="pc-org-identity-name">{organization.displayName}</bdi>
        <VerificationBadge status={organization.verificationStatus} messages={messages} />
        <span className="pc-org-identity-type">
          {labelFor(messages.typeLabels, organization.type)}
        </span>
      </p>

      {children({
        organizationId,
        locale,
        messages,
        organization,
        permissions,
        reload: () => setReloadToken((value) => value + 1),
      })}
    </main>
  );
}

// Kept importable from here for existing callers; the shell's sidebar shares it.
export { permissionsForRoles } from '@/lib/organization-permissions';
