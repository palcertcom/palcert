'use client';

import type {
  AttestationSettlementLineView,
  OrganizationAttestationRevenueView,
} from '@palcert/contracts';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  PaymentBadge,
  describeAttestationError,
  formatDate,
  money,
} from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, LoadingState } from '@/components/ui/states';
import type { AttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import type { AttestationRevenueQuery } from '@/lib/attestations-api';

/**
 * Attestation revenue: totals per currency and one line per request.
 *
 * Shared by the institution's own page and PalCert finance's view of an
 * institution; the caller supplies the loader, and the server decides which
 * rows each may read.
 */
export function AttestationRevenue({
  locale,
  messages,
  load,
}: {
  locale: Locale;
  messages: AttestationsMessages;
  load: (params: AttestationRevenueQuery) => Promise<OrganizationAttestationRevenueView>;
}) {
  const v = messages.revenue;
  const id = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [data, setData] = useState<OrganizationAttestationRevenueView | null>(null);
  const [lines, setLines] = useState<AttestationSettlementLineView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    (cursor?: string) => load({ ...range, limit: 50, ...(cursor === undefined ? {} : { cursor }) }),
    [load, range],
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void fetchPage()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLines([...result.lines]);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAttestationError(messages, caught));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, messages]);

  function apply(event: FormEvent): void {
    event.preventDefault();
    setRange({
      ...(from === '' ? {} : { from: new Date(`${from}T00:00:00Z`).toISOString() }),
      ...(to === '' ? {} : { to: new Date(`${to}T23:59:59Z`).toISOString() }),
    });
  }

  async function more(): Promise<void> {
    if (data === null || data.nextCursor === null) return;
    try {
      const next = await fetchPage(data.nextCursor);
      setData(next);
      setLines((current) => [...current, ...next.lines]);
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }

  return (
    <div data-testid="attestation-revenue">
      <form className="pc-toolbar" onSubmit={apply}>
        <div className="pc-field">
          <label htmlFor={`${id}-from`}>{v.from}</label>
          <input
            id={`${id}-from`}
            type="date"
            dir="ltr"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="pc-field">
          <label htmlFor={`${id}-to`}>{v.to}</label>
          <input
            id={`${id}-to`}
            type="date"
            dir="ltr"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <button type="submit" className="pc-btn pc-btn-secondary">
          {v.apply}
        </button>
      </form>
      {error === null ? null : <FormError message={error} />}

      {data === null ? (
        <LoadingState label={messages.loading} />
      ) : (
        <>
          <section className="pc-card" aria-label={v.totals}>
            <h2 className="pc-card-title">{v.totals}</h2>
            {data.totals.length === 0 ? (
              <p className="pc-hint">{v.emptyHint}</p>
            ) : (
              <DataTable
                caption={v.totals}
                rows={data.totals}
                rowKey={(row) => row.currency}
                columns={[
                  {
                    key: 'currency',
                    header: messages.types.currency,
                    primary: true,
                    cell: (row) => row.currency,
                  },
                  {
                    key: 'gross',
                    header: v.gross,
                    align: 'end',
                    cell: (row) => money(row.gross, locale),
                  },
                  {
                    key: 'platform',
                    header: v.platformFee,
                    align: 'end',
                    cell: (row) => money(row.platformFee, locale),
                  },
                  {
                    key: 'net',
                    header: v.institutionNet,
                    align: 'end',
                    cell: (row) => (
                      <span data-testid={`net-${row.currency}`}>
                        {money(row.institutionNet, locale)}
                      </span>
                    ),
                  },
                  {
                    key: 'pending',
                    header: v.pending,
                    align: 'end',
                    cell: (row) => money(row.pendingReserved, locale),
                  },
                  {
                    key: 'released',
                    header: v.released,
                    align: 'end',
                    cell: (row) => money(row.released, locale),
                  },
                ]}
              />
            )}
          </section>

          {lines.length === 0 ? (
            <EmptyState icon="balance" title={v.emptyTitle} description={v.emptyHint} />
          ) : (
            <DataTable
              caption={v.lines}
              rows={lines}
              rowKey={(row) => row.requestId}
              columns={[
                {
                  key: 'reference',
                  header: v.reference,
                  primary: true,
                  cell: (row) =>
                    row.attestationReference === null ? (
                      messages.none
                    ) : (
                      <code dir="ltr">{row.attestationReference}</code>
                    ),
                },
                {
                  key: 'applicant',
                  header: v.applicant,
                  cell: (row) => <bdi>{row.ownerDisplayName}</bdi>,
                },
                {
                  key: 'type',
                  header: v.type,
                  cell: (row) => (
                    <bdi>
                      {locale === 'ar' ? row.attestationTypeName.ar : row.attestationTypeName.en}
                    </bdi>
                  ),
                },
                {
                  key: 'payment',
                  header: v.payment,
                  cell: (row) => <PaymentBadge status={row.paymentStatus} messages={messages} />,
                },
                {
                  key: 'gross',
                  header: v.gross,
                  align: 'end',
                  cell: (row) => money(row.gross, locale),
                },
                {
                  key: 'commission',
                  header: v.commission,
                  align: 'end',
                  cell: (row) => (
                    <span className="pc-cell-stack">
                      <span>{money(row.platformFee, locale)}</span>
                      <span className="pc-hint" dir="ltr">
                        {row.platformCommissionPercent}%
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'net',
                  header: v.institutionNet,
                  align: 'end',
                  cell: (row) => money(row.institutionNet, locale),
                },
                {
                  key: 'settled',
                  header: v.settledAt,
                  cell: (row) => formatDate(row.settledAt, locale),
                },
              ]}
            />
          )}
          {data.nextCursor === null ? null : (
            <button type="button" className="pc-btn pc-btn-secondary" onClick={() => void more()}>
              {messages.loadMore}
            </button>
          )}
        </>
      )}
    </div>
  );
}
