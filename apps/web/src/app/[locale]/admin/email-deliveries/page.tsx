'use client';

import {
  EMAIL_DELIVERY_CATEGORIES,
  EMAIL_DELIVERY_STATUSES,
  type EmailDeliveryListQuery,
  type EmailDeliveryView,
} from '@palcert/contracts/email';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
import { describeEmailError } from '@/components/admin/email-settings-form';
import { FormError } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getEmailMessages } from '@/i18n/email-messages';
import type { Locale } from '@/i18n/locales';
import { emailAdminApi } from '@/lib/email-api';
import type { StatusTone } from '@/lib/status-tone';

const TONE: Readonly<Record<string, StatusTone>> = {
  QUEUED: 'warning',
  ACCEPTED: 'neutral',
  DELAYED: 'warning',
  DELIVERED: 'success',
  BOUNCED: 'danger',
  COMPLAINED: 'danger',
  FAILED: 'danger',
  SKIPPED: 'neutral',
};

/** Email delivery metadata (ADR-0146). No message content exists to show. */
export default function EmailDeliveriesPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:email-delivery:read')}>
      <Deliveries />
    </AdminGate>
  );
}

interface Filters {
  status: string;
  category: string;
  template: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { status: '', category: '', template: '', from: '', to: '' };

function toQuery(filters: Filters, cursor?: string): EmailDeliveryListQuery {
  return {
    ...(filters.status ? { status: filters.status as EmailDeliveryListQuery['status'] } : {}),
    ...(filters.category
      ? { category: filters.category as EmailDeliveryListQuery['category'] }
      : {}),
    ...(filters.template ? { template: filters.template.trim().toUpperCase() } : {}),
    ...(filters.from ? { from: new Date(`${filters.from}T00:00:00Z`).toISOString() } : {}),
    ...(filters.to
      ? { to: new Date(new Date(`${filters.to}T00:00:00Z`).getTime() + 86_400_000).toISOString() }
      : {}),
    ...(cursor ? { cursor } : {}),
    limit: 25,
  };
}

function formatWhen(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function Deliveries() {
  const id = useId();
  const locale = useAdminLocale();
  const m = getEmailMessages(locale);
  const d = m.deliveries;
  const { globalPermissions } = useShell();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<EmailDeliveryView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (active: Filters) => {
      setError(null);
      setRows(null);
      try {
        const page = await emailAdminApi.deliveries(toQuery(active));
        setRows([...page.items]);
        setCursor(page.nextCursor);
      } catch (caught) {
        setError(describeEmailError(m, caught).message);
        setRows([]);
      }
    },
    [m],
  );

  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  async function more() {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await emailAdminApi.deliveries(toQuery(filters, cursor));
      setRows((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(describeEmailError(m, caught).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters(draft);
  }

  const select = (
    key: 'status' | 'category',
    label: string,
    options: readonly string[],
    names: Readonly<Record<string, string>>,
  ) => (
    <div className="pc-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <select
        id={`${id}-${key}`}
        value={draft[key]}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        data-testid={`deliveries-filter-${key}`}
      >
        <option value="">{d.any}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {names[option] ?? option}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <main className="pc-page">
      <PageHeader title={d.title} description={d.intro} />
      {globalPermissions.has('admin:email-settings:read') ? (
        <p>
          <Link
            className="pc-btn pc-btn-secondary pc-btn-sm"
            href={`/${locale}/admin/email-settings`}
          >
            {m.nav.settings}
          </Link>
        </p>
      ) : null}

      <section className="pc-card">
        <h2 className="pc-card-title">{d.filters}</h2>
        <form
          className="pc-form pc-filter-grid"
          onSubmit={apply}
          noValidate
          data-testid="deliveries-filters"
        >
          {select('status', d.status, EMAIL_DELIVERY_STATUSES, d.statuses)}
          {select('category', d.category, EMAIL_DELIVERY_CATEGORIES, d.categories)}
          <div className="pc-field">
            <label htmlFor={`${id}-template`}>{d.template}</label>
            <input
              id={`${id}-template`}
              dir="ltr"
              maxLength={64}
              value={draft.template}
              placeholder="PASSWORD_RESET"
              onChange={(event) =>
                setDraft((current) => ({ ...current, template: event.target.value }))
              }
            />
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-from`}>{d.from}</label>
            <input
              id={`${id}-from`}
              type="date"
              dir="ltr"
              value={draft.from}
              onChange={(event) =>
                setDraft((current) => ({ ...current, from: event.target.value }))
              }
            />
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-to`}>{d.to}</label>
            <input
              id={`${id}-to`}
              type="date"
              dir="ltr"
              value={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            />
          </div>
          <div className="pc-actions">
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              onClick={() => {
                setDraft(EMPTY);
                setFilters(EMPTY);
              }}
            >
              {d.clear}
            </button>
            <button type="submit" className="pc-btn" data-testid="deliveries-apply">
              {d.apply}
            </button>
          </div>
        </form>
      </section>

      {error === null ? null : <FormError message={error} />}
      {rows === null ? (
        <LoadingState label={m.settings.loading} />
      ) : rows.length === 0 ? (
        <EmptyState title={d.empty} />
      ) : (
        <section className="pc-card" data-testid="deliveries-table">
          <DataTable
            caption={d.caption}
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'recipient',
                header: d.recipient,
                primary: true,
                cell: (row) => <bdi dir="ltr">{row.recipient}</bdi>,
              },
              {
                key: 'type',
                header: d.type,
                cell: (row) => (
                  <span>
                    {d.categories[row.category] ?? row.category} ·{' '}
                    <code dir="ltr">{row.template}</code>
                  </span>
                ),
              },
              {
                key: 'provider',
                header: d.provider,
                cell: (row) => <span dir="ltr">{row.provider}</span>,
              },
              {
                key: 'status',
                header: d.status,
                cell: (row) => (
                  <StatusBadge
                    label={d.statuses[row.status] ?? row.status}
                    status={row.status}
                    tone={TONE[row.status] ?? 'neutral'}
                    title={row.failureCode !== null ? d.failures[row.failureCode] : undefined}
                  />
                ),
              },
              {
                key: 'failure',
                header: d.failure,
                cell: (row) =>
                  row.failureCode !== null ? (d.failures[row.failureCode] ?? row.failureCode) : '—',
              },
              {
                key: 'attempts',
                header: d.attempts,
                align: 'end',
                cell: (row) => <span dir="ltr">{row.attemptCount}</span>,
              },
              {
                key: 'created',
                header: d.created,
                cell: (row) => formatWhen(row.createdAt, locale),
              },
              {
                key: 'updated',
                header: d.updated,
                cell: (row) => formatWhen(row.lastEventAt ?? row.updatedAt, locale),
              },
            ]}
          />
          {cursor !== null ? (
            <div className="pc-actions">
              <button
                type="button"
                className="pc-btn pc-btn-secondary"
                onClick={() => void more()}
                disabled={loadingMore}
              >
                {d.loadMore}
              </button>
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}
