'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { AdminGate, describeAdminError, useAdminLocale } from '@/components/admin/admin-kit';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { useShell } from '@/components/shell/shell-context';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import {
  adminApi,
  type OrganizationProfileResponse,
  type PendingVerificationResponse,
} from '@/lib/api-client';

/**
 * Every organization on PalCert, and the ones waiting for a verification
 * decision.
 *
 * The listing's member count is not shown: the API returns a placeholder
 * there, and a number that is always zero would be an invented figure. The
 * real count is on each organization's own page.
 */
export default function AdminOrganizationsPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:organization:read')}>
      <Suspense fallback={null}>
        <Organizations />
      </Suspense>
    </AdminGate>
  );
}

type View = 'all' | 'queue';

function Organizations() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const { globalPermissions } = useShell();
  const canVerify = globalPermissions.has('admin:organization:verify');
  const requested = useSearchParams().get('view');
  const [view, setView] = useState<View>(requested === 'queue' && canVerify ? 'queue' : 'all');

  return (
    <main className="pc-page">
      <PageHeader title={messages.organizations.title} description={messages.organizations.intro} />
      {canVerify ? (
        <div className="pc-tabs" role="group" aria-label={messages.organizations.tabsLabel}>
          {(['all', 'queue'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="pc-chip"
              aria-pressed={view === candidate}
              onClick={() => setView(candidate)}
            >
              {candidate === 'all'
                ? messages.organizations.tabAll
                : messages.organizations.tabQueue}
            </button>
          ))}
        </div>
      ) : null}
      {view === 'queue' ? <Queue /> : <All />}
    </main>
  );
}

function All() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const organization = getOrganizationMessages(locale);
  const [rows, setRows] = useState<OrganizationProfileResponse[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await adminApi.organizations(cursor === undefined ? {} : { cursor });
        setRows((current) => [...(cursor === undefined ? [] : (current ?? [])), ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(describeAdminError(messages, caught).message);
      }
    },
    [messages],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const columns: DataColumn<OrganizationProfileResponse>[] = [
    {
      key: 'name',
      header: messages.organizations.name,
      primary: true,
      cell: (row) => (
        <Link href={`/${locale}/admin/organizations/${row.id}`}>
          <bdi>{row.displayName}</bdi>
        </Link>
      ),
    },
    {
      key: 'type',
      header: messages.organizations.type,
      cell: (row) => organization.typeLabels[row.type] ?? row.type,
    },
    {
      key: 'status',
      header: messages.organizations.status,
      cell: (row) => (
        <StatusBadge
          status={row.status}
          label={organization.statusLabels[row.status] ?? row.status}
        />
      ),
    },
    {
      key: 'verification',
      header: messages.organizations.verification,
      cell: (row) => (
        <StatusBadge
          status={row.verificationStatus}
          label={organization.verificationLabels[row.verificationStatus] ?? row.verificationStatus}
        />
      ),
    },
    {
      key: 'created',
      header: messages.organizations.created,
      cell: (row) => <time dateTime={row.createdAt}>{when.format(new Date(row.createdAt))}</time>,
    },
  ];

  if (error !== null) return <ErrorState title={error} />;
  if (rows === null) return <LoadingState label={messages.common.loading} />;
  if (rows.length === 0)
    return <EmptyState icon="organization" title={messages.organizations.empty} />;
  return (
    <>
      <DataTable
        caption={messages.organizations.tabAll}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
      />
      {nextCursor === null ? null : (
        <div className="pc-list-footer">
          <button
            type="button"
            className="secondary"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void load(nextCursor).finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? messages.common.loading : messages.common.loadMore}
          </button>
        </div>
      )}
    </>
  );
}

function Queue() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const [rows, setRows] = useState<PendingVerificationResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .verificationQueue()
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAdminError(messages, caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [messages]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const columns: DataColumn<PendingVerificationResponse>[] = [
    {
      key: 'name',
      header: messages.organizations.name,
      primary: true,
      cell: (row) => <bdi>{row.organizationName}</bdi>,
    },
    {
      key: 'requested',
      header: messages.organizations.requestedAt,
      cell: (row) => (
        <time dateTime={row.requestedAt}>{when.format(new Date(row.requestedAt))}</time>
      ),
    },
    {
      key: 'note',
      header: messages.organizations.note,
      cell: (row) =>
        row.submissionNote === null ? '—' : <bdi className="pc-prose">{row.submissionNote}</bdi>,
    },
    {
      key: 'review',
      header: messages.organizations.review,
      cell: (row) => (
        <Link
          className="pc-btn pc-btn-secondary pc-btn-sm"
          href={`/${locale}/admin/organizations/${row.organizationId}`}
        >
          {messages.organizations.review}
        </Link>
      ),
    },
  ];

  if (error !== null) return <ErrorState title={error} />;
  if (rows === null) return <LoadingState label={messages.common.loading} />;
  if (rows.length === 0)
    return <EmptyState icon="verified" title={messages.organizations.queueEmpty} />;
  return (
    <DataTable
      caption={messages.organizations.tabQueue}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.requestId}
    />
  );
}
