'use client';

import type {
  PayoutDestinationView,
  UserWithdrawableView,
} from '@palcert/contracts/finance/withdrawals';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  WithdrawableBreakdown,
  WithdrawalRequestForm,
  describeWithdrawalError,
} from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { resolveLocale } from '@/i18n/locales';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { balanceApi } from '@/lib/api-client';
import { userWithdrawalsApi } from '@/lib/withdrawals-api';

/**
 * Withdraw funds (spec §29, policies 4 and 5).
 *
 * The breakdown comes first, because the most common question is "why can I
 * not withdraw my whole balance?". Card money is refunded to its card, and
 * the page says so instead of offering it.
 */
export default function WithdrawPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getWithdrawalMessages(locale);
  const router = useRouter();
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);
  const [view, setView] = useState<UserWithdrawableView | null>(null);
  const [destinations, setDestinations] = useState<PayoutDestinationView[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void balanceApi
      .currencies()
      .then((list) => {
        setCurrencies(list);
        setCurrency((current) => current ?? list[0] ?? 'USD');
      })
      .catch(() => setCurrency('USD'));
  }, []);

  const load = useCallback(async () => {
    if (currency === null) return;
    try {
      const [withdrawable, saved] = await Promise.all([
        userWithdrawalsApi.withdrawable(currency),
        userWithdrawalsApi.destinations(),
      ]);
      setView(withdrawable);
      setDestinations(saved);
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught).message);
    }
  }, [currency, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="pc-page">
      <PageHeader title={messages.form.title} description={messages.breakdown.intro} />
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {currencies.length > 1 ? (
        <div className="pc-field pc-field-inline">
          <label htmlFor="withdraw-currency">{messages.form.currency}</label>
          <select
            id="withdraw-currency"
            value={currency ?? ''}
            onChange={(event) => {
              setView(null);
              setCurrency(event.target.value);
            }}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {view === null && failure === null ? <LoadingState label={messages.loading} /> : null}
      {view === null ? null : (
        <div className="pc-detail-grid">
          <div className="pc-detail-main">
            <WithdrawalRequestForm
              api={userWithdrawalsApi}
              locale={locale}
              currency={view.currency}
              available={view.withdrawable}
              minimum={view.minimum}
              maximum={view.maximum}
              destinations={destinations}
              destinationsHref={`/${locale}/balance/payout-destinations`}
              onSubmitted={(request) => router.push(`/${locale}/balance/withdrawals/${request.id}`)}
            />
          </div>
          <aside className="pc-detail-side">
            <WithdrawableBreakdown view={view} locale={locale} />
            <section className="pc-card" aria-labelledby="refund-card">
              <h2 id="refund-card">{messages.balanceCard.refundTitle}</h2>
              <p className="pc-hint">{messages.balanceCard.refundBody}</p>
            </section>
            <p>
              <Link href={`/${locale}/balance/withdrawals`}>{messages.nav.history}</Link>
            </p>
          </aside>
        </div>
      )}
    </main>
  );
}
