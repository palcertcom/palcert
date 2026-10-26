'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  AdminGate,
  describeAdminError,
  Figure,
  useAdminLocale,
} from '@/components/admin/admin-kit';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getAuthMessages } from '@/i18n/auth-messages';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { adminApi, type AdminOverviewResponse } from '@/lib/api-client';

/**
 * The staff console's front page.
 *
 * Only counts the database gives (`GET /admin/overview`), each labelled with
 * what it counts. There is no trend, no estimate and no figure the API did
 * not return: a dashboard that guesses is worse than none.
 */
export default function AdminOverviewPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:organization:read') && can.has('admin:user:read')}>
      <Overview />
    </AdminGate>
  );
}

function Overview() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const organization = getOrganizationMessages(locale);
  const auth = getAuthMessages(locale);
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .overview()
      .then((result) => {
        if (!cancelled) setOverview(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAdminError(messages, caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [messages]);

  const number = new Intl.NumberFormat(locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const base = `/${locale}/admin`;

  return (
    <main className="pc-page">
      <PageHeader title={messages.overview.title} description={messages.overview.intro} />
      {error !== null ? (
        <ErrorState title={error} />
      ) : overview === null ? (
        <LoadingState label={messages.common.loading} />
      ) : (
        <>
          <p className="pc-hint">
            {messages.overview.asOf}{' '}
            <time dateTime={overview.generatedAt}>
              {when.format(new Date(overview.generatedAt))}
            </time>
          </p>
          <div className="pc-admin-cards">
            <section className="pc-card" aria-labelledby="admin-organizations-heading">
              <h2 id="admin-organizations-heading" className="pc-card-title">
                {messages.overview.organizations}
              </h2>
              <div className="pc-admin-figures">
                <Figure
                  label={messages.overview.total}
                  value={number.format(overview.organizations.total)}
                />
                <Figure
                  label={messages.overview.pendingVerification}
                  value={number.format(overview.organizations.pendingVerificationRequests)}
                />
              </div>
              <h3 className="pc-subheading">{messages.overview.byStatus}</h3>
              <dl className="pc-summary">
                {Object.entries(overview.organizations.byStatus).map(([status, count]) => (
                  <Pair
                    key={status}
                    label={organization.statusLabels[status] ?? status}
                    value={number.format(count)}
                  />
                ))}
              </dl>
              <h3 className="pc-subheading">{messages.overview.byVerification}</h3>
              <dl className="pc-summary">
                {Object.entries(overview.organizations.byVerificationStatus).map(
                  ([status, count]) => (
                    <Pair
                      key={status}
                      label={organization.verificationLabels[status] ?? status}
                      value={number.format(count)}
                    />
                  ),
                )}
              </dl>
              <div className="pc-actions">
                <Link className="pc-btn pc-btn-secondary" href={`${base}/organizations?view=queue`}>
                  {messages.overview.reviewQueue}
                </Link>
              </div>
            </section>

            <section className="pc-card" aria-labelledby="admin-users-heading">
              <h2 id="admin-users-heading" className="pc-card-title">
                {messages.overview.users}
              </h2>
              <div className="pc-admin-figures">
                <Figure
                  label={messages.overview.total}
                  value={number.format(overview.users.total)}
                />
              </div>
              <h3 className="pc-subheading">{messages.overview.byStatus}</h3>
              <dl className="pc-summary">
                {Object.entries(overview.users.byStatus).map(([status, count]) => (
                  <Pair
                    key={status}
                    label={auth.accountStatusLabels[status] ?? status}
                    value={number.format(count)}
                  />
                ))}
              </dl>
              <div className="pc-actions">
                <Link className="pc-btn pc-btn-secondary" href={`${base}/users`}>
                  {messages.nav.users}
                </Link>
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
