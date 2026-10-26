'use client';

import {
  WITHDRAWAL_SCOPES,
  type WithdrawalQueueItemView,
  type WithdrawalQueueView,
  type WithdrawalScope,
  type WithdrawalStatus,
} from '@palcert/contracts/finance/withdrawals';
import { WITHDRAWAL_CURRENCIES } from '@palcert/contracts/finance/withdrawals';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
import { Amount, WithdrawalStatusBadge, describeWithdrawalError } from '@/components/withdrawal';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { withdrawalAdminApi, type QueueParams } from '@/lib/withdrawals-api';

const TABS: readonly WithdrawalStatus[] = [
  'PENDING_REVIEW',
  'APPROVED',
  'PROCESSING',
  'FAILED',
  'PAID',
  'REJECTED',
  'CANCELLED',
];

/**
 * The withdrawal queue (spec §32): tabs by status, filters by scope,
 * currency and date, and open totals per status and currency — never one
 * figure that adds shekels to dollars.
 */
export default function AdminWithdrawalsPage() {
  return (
    <AdminGate allowed={(can) => can.has('finance:withdrawal:read')}>
      <Queue />
    </AdminGate>
  );
}

function Queue() {
  const locale = useAdminLocale();
  const messages = getWithdrawalMessages(locale);
  const a = messages.admin;
  const [status, setStatus] = useState<WithdrawalStatus | undefined>('PENDING_REVIEW');
  const [scope, setScope] = useState<WithdrawalScope | ''>('');
  const [currency, setCurrency] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState<QueueParams>({});
  const [queue, setQueue] = useState<WithdrawalQueueView | null>(null);
  const [items, setItems] = useState<WithdrawalQueueItemView[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await withdrawalAdminApi.queue({
          ...applied,
          ...(status === undefined ? {} : { status }),
          limit: 25,
          ...(cursor === undefined ? {} : { cursor }),
        });
        setQueue(page);
        setItems((current) =>
          cursor === undefined ? [...page.items] : [...current, ...page.items],
        );
      } catch (caught) {
        setFailure(describeWithdrawalError(messages, caught).message);
      }
    },
    [applied, messages, status],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="pc-page">
      <PageHeader title={a.queueTitle} description={a.queueIntro} />
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}

      <nav aria-label={a.queueCaption}>
        <ul className="pc-withdrawal-tabs" role="list">
          {[...TABS, undefined].map((tab) => (
            <li key={tab ?? 'all'}>
              <button
                type="button"
                className={
                  tab === status
                    ? 'pc-btn pc-btn-primary pc-btn-sm'
                    : 'pc-btn pc-btn-secondary pc-btn-sm'
                }
                aria-pressed={tab === status}
                onClick={() => setStatus(tab)}
              >
                {tab === undefined ? a.allStatuses : a.tabs[tab]}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="pc-card" aria-labelledby="queue-filters">
        <h2 id="queue-filters" className="pc-visually-hidden">
          {a.filters.title}
        </h2>
        <form
          className="pc-withdrawal-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({
              ...(scope === '' ? {} : { scope }),
              ...(currency === '' ? {} : { currency }),
              ...(from === '' ? {} : { from: new Date(`${from}T00:00:00Z`).toISOString() }),
              ...(to === '' ? {} : { to: new Date(`${to}T00:00:00Z`).toISOString() }),
            });
          }}
        >
          <div className="pc-field">
            <label htmlFor="filter-scope">{a.filters.scope}</label>
            <select
              id="filter-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as WithdrawalScope | '')}
            >
              <option value="">{a.filters.anyScope}</option>
              {WITHDRAWAL_SCOPES.map((value) => (
                <option key={value} value={value}>
                  {messages.scopes[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="pc-field">
            <label htmlFor="filter-currency">{a.filters.currency}</label>
            <select
              id="filter-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option value="">{a.filters.anyCurrency}</option>
              {WITHDRAWAL_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="pc-field">
            <label htmlFor="filter-from">{a.filters.from}</label>
            <input
              id="filter-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="pc-field">
            <label htmlFor="filter-to">{a.filters.to}</label>
            <input
              id="filter-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <div className="pc-actions">
            <button type="submit" className="pc-btn pc-btn-secondary">
              {a.filters.apply}
            </button>
            <button
              type="button"
              className="pc-btn pc-btn-quiet"
              onClick={() => {
                setScope('');
                setCurrency('');
                setFrom('');
                setTo('');
                setApplied({});
              }}
            >
              {a.filters.clear}
            </button>
          </div>
        </form>
      </section>

      {queue === null ? (
        failure === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <>
          {queue.totals.length === 0 ? null : (
            <section className="pc-card" aria-labelledby="open-totals">
              <h2 id="open-totals">{a.totalsTitle}</h2>
              <DataTable<WithdrawalQueueView['totals'][number]>
                caption={a.totalsCaption}
                rows={queue.totals}
                rowKey={(row) => `${row.status}:${row.currency}`}
                columns={[
                  {
                    key: 'status',
                    header: a.columns.status,
                    primary: true,
                    cell: (row) => <WithdrawalStatusBadge status={row.status} locale={locale} />,
                  },
                  {
                    key: 'currency',
                    header: a.filters.currency,
                    cell: (row) => <span className="pc-ltr">{row.currency}</span>,
                  },
                  {
                    key: 'count',
                    header: a.columns.count,
                    align: 'end',
                    cell: (row) => row.count.toLocaleString(locale),
                  },
                  {
                    key: 'total',
                    header: a.columns.amount,
                    align: 'end',
                    cell: (row) => <Amount amount={row.total} locale={locale} />,
                  },
                ]}
              />
            </section>
          )}
          <section className="pc-card">
            {items.length === 0 ? (
              <p className="pc-hint">{a.empty}</p>
            ) : (
              <DataTable<WithdrawalQueueItemView>
                caption={a.queueCaption}
                rows={items}
                rowKey={(row) => row.id}
                scrollable
                columns={[
                  {
                    key: 'reference',
                    header: a.columns.reference,
                    primary: true,
                    cell: (row) => (
                      <Link className="pc-ltr" href={`/${locale}/admin/withdrawals/${row.id}`}>
                        {row.reference}
                      </Link>
                    ),
                  },
                  {
                    key: 'scope',
                    header: a.columns.scope,
                    cell: (row) => messages.scopes[row.scope],
                  },
                  {
                    key: 'requester',
                    header: a.columns.requester,
                    cell: (row) => (
                      <span>
                        <span dir="auto">{row.requesterDisplayName ?? row.requesterEmail}</span>
                        {row.organizationName === null ? null : (
                          <span className="pc-hint" dir="auto">
                            {' '}
                            · {row.organizationName}
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'beneficiary',
                    header: a.columns.beneficiary,
                    cell: (row) => <span dir="auto">{row.beneficiaryName}</span>,
                  },
                  {
                    key: 'amount',
                    header: a.columns.amount,
                    align: 'end',
                    cell: (row) => <Amount amount={row.amount} locale={locale} />,
                  },
                  {
                    key: 'status',
                    header: a.columns.status,
                    cell: (row) => <WithdrawalStatusBadge status={row.status} locale={locale} />,
                  },
                  {
                    key: 'submitted',
                    header: a.columns.submitted,
                    cell: (row) =>
                      row.submittedAt === null ? (
                        '—'
                      ) : (
                        <time dateTime={row.submittedAt}>
                          {new Date(row.submittedAt).toLocaleString(locale)}
                        </time>
                      ),
                  },
                ]}
              />
            )}
            {queue.nextCursor === null ? null : (
              <button
                type="button"
                className="pc-btn pc-btn-secondary"
                onClick={() => void load(queue.nextCursor ?? undefined)}
              >
                {messages.history.loadMore}
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
