'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { VerificationBadge } from '@/components/verified-badge';
import { getAuthMessages } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';
import { getOrganizationMessages, labelFor } from '@/i18n/organization-messages';
import { ApiError, organizationApi, type UserOrganizationResponse } from '@/lib/api-client';

export default function OrganizationsPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getOrganizationMessages(locale);
  const auth = getAuthMessages(locale);
  const router = useRouter();

  const [organizations, setOrganizations] = useState<UserOrganizationResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void organizationApi
      .mine()
      .then((result) => {
        if (!cancelled) setOrganizations(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
          router.push(`/${locale}/unauthorized`);
          return;
        }
        setError(auth.genericError);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, locale, router]);

  return (
    <main className="pc-page">
      <PageHeader
        title={messages.organizations}
        actions={
          <Link className="pc-btn" href={`/${locale}/organizations/new`}>
            <Icon name="plus" size={18} />
            {messages.createOrganization}
          </Link>
        }
      />
      <FormError message={error} />

      {organizations === null && error === null && <LoadingState label={auth.sending} />}

      {organizations !== null && organizations.length === 0 && (
        <EmptyState
          icon="organization"
          title={messages.noOrganizations}
          headingLevel={2}
          action={
            <Link className="pc-btn pc-btn-secondary" href={`/${locale}/organizations/new`}>
              {messages.createOrganization}
            </Link>
          }
        />
      )}

      {organizations !== null && organizations.length > 0 && (
        <ul className="pc-org-cards">
          {organizations.map((entry) => (
            <li key={entry.organization.id} className="pc-card pc-org-card">
              <h2 className="pc-card-title">
                <Link href={`/${locale}/organizations/${entry.organization.id}`}>
                  <bdi>{entry.organization.displayName}</bdi>
                </Link>
              </h2>
              <p className="pc-org-card-meta">
                <VerificationBadge
                  status={entry.organization.verificationStatus}
                  messages={messages}
                />
                <span>{labelFor(messages.typeLabels, entry.organization.type)}</span>
                {entry.membershipStatus !== 'ACTIVE' && (
                  <StatusBadge
                    status={entry.membershipStatus}
                    label={labelFor(messages.statusLabels, entry.membershipStatus)}
                  />
                )}
              </p>
              {entry.roles.length > 0 && (
                <p className="pc-tag-list" aria-label={messages.roles}>
                  {entry.roles.map((role) => (
                    <span key={role} className="pc-tag">
                      {labelFor(messages.roleLabels, role)}
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
