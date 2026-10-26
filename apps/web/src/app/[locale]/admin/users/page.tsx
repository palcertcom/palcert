'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AdminGate, describeAdminError, useAdminLocale } from '@/components/admin/admin-kit';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getAuthMessages } from '@/i18n/auth-messages';
import { ADMIN_USER_PAGE_SIZE, adminApi, type AdminUserSummaryResponse } from '@/lib/api-client';

/**
 * PalCert accounts, newest first, with a search by part of an email address
 * or a name. The list carries no roles or permissions; those are on each
 * account's own page.
 */
export default function AdminUsersPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:user:read')}>
      <Users />
    </AdminGate>
  );
}

function Users() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const auth = getAuthMessages(locale);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<AdminUserSummaryResponse[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await adminApi.users({
          ...(query === '' ? {} : { q: query }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        setRows((current) => [...(cursor === undefined ? [] : (current ?? [])), ...page]);
        // The API pages by the last id seen and says nothing else: a full page
        // may have more behind it, a short one does not.
        setMore(page.length === ADMIN_USER_PAGE_SIZE);
        setError(null);
      } catch (caught) {
        setError(describeAdminError(messages, caught).message);
      }
    },
    [messages, query],
  );

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const date = (value: string | null) =>
    value === null ? (
      messages.common.never
    ) : (
      <time dateTime={value}>{when.format(new Date(value))}</time>
    );

  const columns: DataColumn<AdminUserSummaryResponse>[] = [
    {
      key: 'account',
      header: messages.users.name,
      primary: true,
      cell: (row) => (
        <span className="pc-cell-stack">
          <Link href={`/${locale}/admin/users/${row.id}`}>
            <bdi>{row.displayName ?? row.email}</bdi>
          </Link>
          {row.displayName === null ? null : (
            <span className="pc-hint" dir="ltr">
              {row.email}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: messages.users.status,
      cell: (row) => (
        <StatusBadge
          status={row.status}
          label={auth.accountStatusLabels[row.status] ?? row.status}
        />
      ),
    },
    {
      key: 'verified',
      header: messages.users.emailVerified,
      cell: (row) => (row.emailVerified ? messages.common.yes : messages.common.no),
    },
    { key: 'created', header: messages.users.created, cell: (row) => date(row.createdAt) },
    { key: 'last', header: messages.users.lastLogin, cell: (row) => date(row.lastLoginAt) },
  ];

  return (
    <main className="pc-page">
      <PageHeader title={messages.users.title} description={messages.users.intro} />
      <form
        className="pc-search-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <div className="pc-field">
          <label htmlFor="adminUserSearch">{messages.users.searchLabel}</label>
          <input
            id="adminUserSearch"
            type="search"
            value={draft}
            maxLength={120}
            aria-describedby="adminUserSearchHint"
            onChange={(event) => setDraft(event.target.value)}
          />
          <p id="adminUserSearchHint" className="pc-hint">
            {messages.users.searchHint}
          </p>
        </div>
        <button type="submit" className="secondary">
          {messages.common.search}
        </button>
        {query === '' ? null : (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setDraft('');
              setQuery('');
            }}
          >
            {messages.common.clear}
          </button>
        )}
      </form>

      {error !== null ? (
        <ErrorState title={error} />
      ) : rows === null ? (
        <LoadingState label={messages.common.loading} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="team"
          title={query === '' ? messages.users.empty : messages.users.noMatches}
        />
      ) : (
        <DataTable
          caption={messages.users.title}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      )}

      {more && rows !== null && rows.length > 0 && error === null ? (
        <div className="pc-list-footer">
          <button
            type="button"
            className="secondary"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void load(rows[rows.length - 1]!.id).finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? messages.common.loading : messages.common.loadMore}
          </button>
        </div>
      ) : null}
    </main>
  );
}
