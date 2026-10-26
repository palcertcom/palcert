'use client';

import type {
  PayoutDestinationView,
  PlatformFundsRowView,
  PlatformFundsView,
  WithdrawalRequestView,
} from '@palcert/contracts/finance/withdrawals';
import { WITHDRAWAL_CURRENCIES } from '@palcert/contracts/finance/withdrawals';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
import {
  Amount,
  DestinationManager,
  WithdrawalHistory,
  WithdrawalRequestForm,
  describeWithdrawalError,
} from '@/components/withdrawal';
import { useShell } from '@/components/shell/shell-context';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { platformFundsApi } from '@/lib/withdrawals-api';

/**
 * PalCert's own funds (spec §31, D5): realized revenue per currency with the
 * sources behind it, treasury destinations, and platform payout requests —
 * which then need a second person to approve and a third to execute.
 */
export default function PlatformFundsPage() {
  return (
    <AdminGate allowed={(can) => can.has('finance:withdrawal:read')}>
      <Funds />
    </AdminGate>
  );
}

function Funds() {
  const locale = useAdminLocale();
  const messages = getWithdrawalMessages(locale);
  const p = messages.platform;
  const c = messages.organization.columns;
  const router = useRouter();
  const { globalPermissions: can } = useShell();
  const canRequest = can.has('finance:platform-withdrawal:request');
  const [funds, setFunds] = useState<PlatformFundsView | null>(null);
  const [history, setHistory] = useState<WithdrawalRequestView[]>([]);
  const [destinations, setDestinations] = useState<PayoutDestinationView[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [view, page] = await Promise.all([
        platformFundsApi.funds(),
        platformFundsApi.list({ limit: 25 }),
      ]);
      setFunds(view);
      setHistory(page.items);
      setCurrency((current) => current ?? view.rows[0]?.currency ?? null);
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught).message);
    }
  }, [messages]);

  useEffect(() => {
    void load();
  }, [load]);

  const row = funds?.rows.find((entry) => entry.currency === currency) ?? null;

  return (
    <main className="pc-page">
      <PageHeader title={p.title} description={p.intro} />
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {funds === null ? (
        failure === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <>
          <section className="pc-card" aria-labelledby="platform-funds">
            <h2 id="platform-funds">{p.title}</h2>
            {funds.rows.length === 0 ? (
              <p className="pc-hint">{p.empty}</p>
            ) : (
              <DataTable<PlatformFundsRowView>
                caption={p.caption}
                rows={funds.rows}
                rowKey={(entry) => entry.currency}
                scrollable
                columns={[
                  {
                    key: 'currency',
                    header: c.currency,
                    primary: true,
                    cell: (entry) => <span className="pc-ltr">{entry.currency}</span>,
                  },
                  {
                    key: 'services',
                    header: p.sources.cashServiceRevenue,
                    align: 'end',
                    cell: (entry) => <Amount amount={entry.cashServiceRevenue} locale={locale} />,
                  },
                  {
                    key: 'commission',
                    header: p.sources.attestationCommission,
                    align: 'end',
                    cell: (entry) => (
                      <Amount amount={entry.attestationCommission} locale={locale} />
                    ),
                  },
                  {
                    key: 'refunds',
                    header: p.sources.serviceRefunds,
                    align: 'end',
                    cell: (entry) => <Amount amount={entry.serviceRefunds} locale={locale} />,
                  },
                  {
                    key: 'chargebacks',
                    header: p.sources.unrecoveredChargebackLoss,
                    align: 'end',
                    cell: (entry) => (
                      <Amount amount={entry.unrecoveredChargebackLoss} locale={locale} />
                    ),
                  },
                  {
                    key: 'realized',
                    header: c.realized,
                    align: 'end',
                    cell: (entry) => <Amount amount={entry.realized} locale={locale} />,
                  },
                  {
                    key: 'reserved',
                    header: c.reserved,
                    align: 'end',
                    cell: (entry) => <Amount amount={entry.reserved} locale={locale} />,
                  },
                  {
                    key: 'paidOut',
                    header: c.paidOut,
                    align: 'end',
                    cell: (entry) => <Amount amount={entry.paidOut} locale={locale} />,
                  },
                  {
                    key: 'available',
                    header: c.available,
                    align: 'end',
                    cell: (entry) => (
                      <strong>
                        <Amount amount={entry.available} locale={locale} />
                      </strong>
                    ),
                  },
                ]}
              />
            )}
          </section>

          {canRequest && row !== null ? (
            <>
              <p className="pc-alert pc-alert-info">{p.threePeople}</p>
              {funds.rows.length > 1 ? (
                <div className="pc-field pc-field-inline">
                  <label htmlFor="platform-currency">{messages.form.currency}</label>
                  <select
                    id="platform-currency"
                    value={currency ?? ''}
                    onChange={(event) => setCurrency(event.target.value)}
                  >
                    {funds.rows.map((entry) => (
                      <option key={entry.currency} value={entry.currency}>
                        {entry.currency}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <WithdrawalRequestForm
                api={platformFundsApi}
                locale={locale}
                currency={row.currency}
                available={row.available}
                minimum={row.minimum}
                maximum={row.maximum}
                destinations={destinations}
                onSubmitted={(request) => router.push(`/${locale}/admin/withdrawals/${request.id}`)}
              />
            </>
          ) : null}

          {can.has('finance:payout-destination:read') ? (
            <DestinationManager
              api={platformFundsApi}
              locale={locale}
              title={messages.destinations.platformTitle}
              canManage={can.has('finance:payout-destination:manage')}
              currencies={WITHDRAWAL_CURRENCIES}
              onChange={setDestinations}
            />
          ) : null}

          <section className="pc-card" aria-labelledby="platform-history">
            <h2 id="platform-history">{messages.history.platformTitle}</h2>
            <WithdrawalHistory
              items={history}
              locale={locale}
              caption={messages.history.platformTitle}
              hrefFor={(item) => `/${locale}/admin/withdrawals/${item.id}`}
            />
          </section>
        </>
      )}
    </main>
  );
}
