'use client';

import type {
  AdminManualTopUpListItemView,
  AdminManualTopUpQueueView,
  ManualTopUpStatus,
} from '@palcert/contracts/finance/manual-topups';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
import { TopUpAmount, TopUpStatusBadge, describeTopUpError } from '@/components/manual-topup';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { manualTopUpsAdminApi, type QueueParams } from '@/lib/manual-topups-api';

const STATUSES: readonly ManualTopUpStatus[] = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];
const CURRENCIES = ['ILS', 'USD', 'JOD', 'EUR'] as const;

/** PalCert finance's queue: reported transfers, oldest first, with what is waiting per currency. */
export default function AdminTopUpQueuePage() {
  return (
    <AdminGate allowed={(can) => can.has('finance:manual-topup:read')}>
      <Queue />
    </AdminGate>
  );
}

function Queue() {
  const locale = useAdminLocale();
  const messages = getManualTopUpMessages(locale);
  const a = messages.admin;
  const [filters, setFilters] = useState<QueueParams>({ status: 'PENDING_REVIEW' });
  const [form, setForm] = useState({ status: 'PENDING_REVIEW', currency: '', reference: '' });
  const [data, setData] = useState<AdminManualTopUpQueueView | null>(null);
  const [items, setItems] = useState<AdminManualTopUpListItemView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await manualTopUpsAdminApi.queue({
          ...filters,
          limit: 25,
          ...(cursor ? { cursor } : {}),
        });
        setData(page);
        setItems((current) =>
          cursor === undefined ? [...page.items] : [...current, ...page.items],
        );
        setError(null);
      } catch (caught) {
        setError(describeTopUpError(messages, caught).message);
      }
    },
    [filters, messages],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function apply(event: FormEvent): void {
    event.preventDefault();
    setFilters({
      ...(form.status === '' ? {} : { status: form.status as ManualTopUpStatus }),
      ...(form.currency === '' ? {} : { currency: form.currency }),
      ...(form.reference.trim() === '' ? {} : { reference: form.reference.trim() }),
    });
  }

  return (
    <main className="pc-page">
      <PageHeader title={a.queueTitle} description={a.queueIntro} />
      {error === null ? null : (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}

      {data === null ? null : (
        <section className="pc-card" aria-labelledby="pending-totals">
          <h2 id="pending-totals" className="pc-card-title">
            {a.pendingTotals}
          </h2>
          {data.pendingTotals.length === 0 ? (
            <p className="pc-hint">{a.emptyQueue}</p>
          ) : (
            <dl className="pc-summary">
              {data.pendingTotals.map((total) => (
                <div key={total.currency}>
                  <dt>
                    {total.currency} · {total.count}
                  </dt>
                  <dd>
                    <TopUpAmount amount={total.total} locale={locale} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}

      <form className="pc-card pc-filter-grid" onSubmit={apply} aria-label={a.applyFilters}>
        <label className="pc-field">
          <span>{a.filterStatus}</span>
          <select
            value={form.status}
            onChange={(event) => setForm({ ...form, status: event.target.value })}
          >
            <option value="">{a.all}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {messages.staffStatuses[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="pc-field">
          <span>{a.filterCurrency}</span>
          <select
            value={form.currency}
            onChange={(event) => setForm({ ...form, currency: event.target.value })}
          >
            <option value="">{a.all}</option>
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>
        <label className="pc-field">
          <span>{a.filterReference}</span>
          <input
            dir="ltr"
            value={form.reference}
            onChange={(event) => setForm({ ...form, reference: event.target.value })}
          />
        </label>
        <div className="pc-actions">
          <button type="submit" className="pc-btn pc-btn-secondary">
            {a.applyFilters}
          </button>
        </div>
      </form>

      {data === null && error === null ? <LoadingState label={messages.loading} /> : null}
      {data !== null && items.length === 0 ? (
        <EmptyState icon="balance" title={a.emptyQueue} />
      ) : null}
      {items.length === 0 ? null : (
        <section className="pc-card">
          <DataTable
            caption={a.queueTitle}
            rows={items}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'customer',
                header: a.columnCustomer,
                primary: true,
                cell: (row) => (
                  <Link href={`/${locale}/admin/top-ups/${row.id}`}>
                    {row.ownerDisplayName ?? row.ownerEmail}
                    <span className="pc-hint pc-ltr" dir="ltr">
                      {' '}
                      {row.reference}
                    </span>
                  </Link>
                ),
              },
              {
                key: 'amount',
                header: messages.waiting.amount,
                align: 'end',
                cell: (row) => <TopUpAmount amount={row.amount} locale={locale} />,
              },
              {
                key: 'method',
                header: a.columnMethod,
                cell: (row) =>
                  locale === 'ar' ? row.paymentMethodNameAr : row.paymentMethodNameEn,
              },
              {
                key: 'receipt',
                header: a.columnReceipt,
                cell: (row) => (row.hasReceipt ? a.hasReceipt : a.noReceipt),
              },
              {
                key: 'status',
                header: a.filterStatus,
                cell: (row) => (
                  <TopUpStatusBadge status={row.status} locale={locale} audience="staff" />
                ),
              },
              {
                key: 'when',
                header: messages.waiting.submittedAt,
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
          {data?.nextCursor ? (
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              onClick={() => void load(data.nextCursor!)}
            >
              {messages.history.loadMore}
            </button>
          ) : null}
        </section>
      )}
    </main>
  );
}
