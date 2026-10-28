'use client';
import { useEffect, useState } from 'react';
import type { OrganizationServiceRevenueView } from '@palcert/contracts';
import { revenueSharingApi } from '@/lib/revenue-sharing-api';
import { revenueMessages } from '@/i18n/revenue-sharing-messages';
import { money } from '@/components/attestation';
import type { Locale } from '@/i18n/locales';
import { DataTable } from '@/components/ui/data-table';
import { FormError } from '@/components/auth-form';

export function ServiceRevenue({
  organizationId,
  locale,
  admin = false,
}: {
  organizationId: string;
  locale: Locale;
  admin?: boolean;
}) {
  const m = revenueMessages(locale);
  const [view, setView] = useState<OrganizationServiceRevenueView | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setView(null);
    setError(false);
    void revenueSharingApi
      .revenue(organizationId, admin, cursor)
      .then((result) => {
        if (active) setView(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [organizationId, admin, cursor]);
  if (error) return <FormError message={m.error} />;
  if (!view) return <p role="status">{m.loading}</p>;
  return (
    <section className="pc-card">
      <h2>{m.revenue}</h2>
      <DataTable
        caption={m.revenue}
        rows={view.totals}
        rowKey={(row) => `${row.serviceCode}:${row.currency}`}
        columns={[
          { key: 'service', header: m.service, cell: (row) => m.services[row.serviceCode] },
          { key: 'currency', header: m.currency, cell: (row) => row.currency },
          { key: 'gross', header: m.gross, cell: (row) => money(row.gross, locale) },
          {
            key: 'institution',
            header: m.institution,
            cell: (row) => money(row.institution, locale),
          },
          { key: 'platform', header: m.platform, cell: (row) => money(row.platform, locale) },
        ]}
      />
      <h3>{m.transactions}</h3>
      {view.entries.length === 0 ? (
        <p>{m.empty}</p>
      ) : (
        <DataTable
          caption={m.transactions}
          rows={view.entries}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'service',
              header: m.service,
              cell: (row) => (
                <>
                  {m.services[row.serviceCode]} · {row.isRefund ? m.refund : m.captured}
                </>
              ),
            },
            {
              key: 'date',
              header: m.date,
              cell: (row) => new Date(row.createdAt).toLocaleString(locale),
            },
            {
              key: 'gross',
              header: m.gross,
              cell: (row) => `${money(row.gross, locale)} ${row.currency}`,
            },
            {
              key: 'institution',
              header: m.institution,
              cell: (row) => `${money(row.institution, locale)} ${row.currency}`,
            },
            {
              key: 'platform',
              header: m.platform,
              cell: (row) => `${money(row.platform, locale)} ${row.currency}`,
            },
          ]}
        />
      )}
      {view.nextCursor && (
        <button className="pc-btn pc-btn-secondary" onClick={() => setCursor(view.nextCursor!)}>
          {m.more}
        </button>
      )}
    </section>
  );
}
