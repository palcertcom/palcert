'use client';

import type { ManualTopUpRequestView } from '@palcert/contracts/finance/manual-topups';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  TopUpAmount,
  TopUpStatusBadge,
  describeTopUpError,
  methodName,
} from '@/components/manual-topup';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { resolveLocale } from '@/i18n/locales';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { manualTopUpsApi } from '@/lib/manual-topups-api';

/** Every transfer a person has reported, newest first, and what became of it. */
export default function TopUpHistoryPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getManualTopUpMessages(locale);
  const h = messages.history;
  const [items, setItems] = useState<ManualTopUpRequestView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await manualTopUpsApi.list({ limit: 20, ...(cursor ? { cursor } : {}) });
        setItems((current) =>
          cursor === undefined ? page.items : [...(current ?? []), ...page.items],
        );
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(describeTopUpError(messages, caught).message);
        setItems((current) => current ?? []);
      }
    },
    [messages],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="pc-page">
      <PageHeader
        title={h.title}
        description={h.intro}
        actions={
          <Link className="pc-btn pc-btn-primary" href={`/${locale}/balance/add`}>
            {messages.hero.addBalance}
          </Link>
        }
      />
      {error === null ? null : (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}
      {items === null ? <LoadingState label={messages.loading} /> : null}
      {items !== null && items.length === 0 && error === null ? (
        <EmptyState icon="balance" title={h.empty} />
      ) : null}
      {items !== null && items.length > 0 ? (
        <section className="pc-card">
          <DataTable
            caption={h.title}
            rows={items}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'method',
                header: h.columnRequest,
                primary: true,
                cell: (row) => (
                  <Link href={`/${locale}/balance/top-ups/${row.id}`}>
                    {methodName(row.paymentMethod, locale)}
                    {row.reference === null ? null : (
                      <span className="pc-hint pc-ltr" dir="ltr">
                        {' '}
                        {row.reference}
                      </span>
                    )}
                  </Link>
                ),
              },
              {
                key: 'amount',
                header: h.columnAmount,
                align: 'end',
                cell: (row) =>
                  row.amount.minorUnits === '0' ? (
                    '—'
                  ) : (
                    <TopUpAmount amount={row.amount} locale={locale} />
                  ),
              },
              {
                key: 'status',
                header: h.columnStatus,
                cell: (row) => <TopUpStatusBadge status={row.status} locale={locale} />,
              },
              {
                key: 'when',
                header: h.columnWhen,
                cell: (row) => (
                  <time dateTime={row.submittedAt ?? row.createdAt}>
                    {new Date(row.submittedAt ?? row.createdAt).toLocaleDateString(locale)}
                  </time>
                ),
              },
            ]}
          />
          {nextCursor === null ? null : (
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              onClick={() => void load(nextCursor)}
            >
              {h.loadMore}
            </button>
          )}
        </section>
      ) : null}
    </main>
  );
}
