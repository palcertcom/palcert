'use client';

import type { ManualTopUpRequestView } from '@palcert/contracts/finance/manual-topups';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AddCreditPanel,
  AddCreditUnavailable,
  BalanceHero,
  HoldList,
  RefundList,
  TopUpHistory,
  TransactionHistory,
} from '@/components/balance-panels';
import { MethodMark, TopUpAmount, TopUpStatusBadge, methodName } from '@/components/manual-topup';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getBalanceMessages } from '@/i18n/balance-messages';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  balanceApi,
  type BalanceSummaryResponse,
  type BalanceTopUpResponse,
  type CreditHoldResponse,
  type LedgerEntryResponse,
  type PaymentRefundResponse,
} from '@/lib/api-client';
import { manualTopUpsApi } from '@/lib/manual-topups-api';
import { WithdrawCard } from '@/components/withdrawal';
import { useShell } from '@/components/shell/shell-context';

/**
 * PalCert Balance (§114, §115).
 *
 * One page answers the three questions a customer actually has: how much can
 * I spend, what is set aside, and where did the rest go. Nothing here can
 * move money — adding credit leaves for the provider, and refunds to a card
 * are arranged by PalCert rather than offered as a button (§72, §95).
 */
export default function BalancePage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getBalanceMessages(locale);
  const topUpMessages = getManualTopUpMessages(locale);
  const router = useRouter();

  const [summary, setSummary] = useState<BalanceSummaryResponse | null>(null);
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [entries, setEntries] = useState<LedgerEntryResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [topUps, setTopUps] = useState<BalanceTopUpResponse[]>([]);
  const [holds, setHolds] = useState<CreditHoldResponse[]>([]);
  const [refunds, setRefunds] = useState<PaymentRefundResponse[]>([]);
  const [paymentsAvailable, setPaymentsAvailable] = useState(true);
  const [transfers, setTransfers] = useState<ManualTopUpRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [balance, page, activeHolds, history, refundHistory] = await Promise.all([
        balanceApi.balance(),
        balanceApi.transactions({ limit: 25 }),
        balanceApi.holds(),
        balanceApi.topUps(),
        balanceApi.refunds(),
      ]);
      setSummary(balance);
      setEntries(page.items);
      setNextCursor(page.nextCursor);
      setHolds(activeHolds);
      setTopUps(history);
      setRefunds(refundHistory);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push(`/${locale}/unauthorized`);
        return;
      }
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? messages.genericError)
          : messages.genericError,
      );
    }

    // Whether credit can be added is a separate question from whether the
    // balance can be read: a provider outage must never blank this page.
    //
    // It is also a separate question from which currencies the ledger holds,
    // which is what this used to ask. `/balance/currencies` is a read of the
    // customer's own entries and succeeds whether or not a payment provider
    // exists, so a deployment running with payments switched off still offered
    // the top-up form — a control that could only produce a 503 (Checkpoint
    // 20.8). The API has reported the real answer since Phase 10.
    // Transfers in progress are their own question too: a failure here hides
    // the section rather than the balance.
    try {
      const own = await manualTopUpsApi.list({ limit: 20 });
      setTransfers(
        own.items.filter(
          (request) => request.status === 'PENDING_REVIEW' || request.status === 'DRAFT',
        ),
      );
    } catch {
      setTransfers([]);
    }

    try {
      setCurrencies(await balanceApi.currencies());
    } catch {
      setCurrencies([]);
    }

    try {
      const payments = await balanceApi.paymentsAvailability();
      setPaymentsAvailable(payments.enabled && payments.available);
    } catch {
      // Unreachable means it cannot be offered. Explaining that adding credit
      // is unavailable is the honest answer; a button that fails on click is
      // not.
      setPaymentsAvailable(false);
    }
  }, [locale, messages, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await balanceApi.transactions({ limit: 25, cursor: nextCursor });
      setEntries((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setError(messages.genericError);
    }
  }

  const defaultCurrency = summary?.currency ?? currencies[0];
  const canWithdraw = useShell().globalPermissions.has('balance:withdraw:self');

  return (
    <main className="pc-page pc-balance">
      <PageHeader title={messages.title} description={messages.subtitle} />

      {error !== null && (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}

      {summary === null && error === null ? (
        <LoadingState label={getShellMessages(locale).loading} />
      ) : null}

      {summary !== null && (
        <BalanceHero
          summary={summary}
          locale={locale}
          addHref={`/${locale}/balance/add`}
          addLabel={topUpMessages.hero.addBalance}
          addHint={topUpMessages.hero.addBalanceHint}
        />
      )}

      {transfers.length === 0 ? null : (
        <section className="pc-card pc-topup-pending" aria-labelledby="pending-transfers">
          <div className="pc-section-heading">
            <h2 id="pending-transfers">{topUpMessages.hero.pendingTitle}</h2>
            <Link href={`/${locale}/balance/top-ups`}>{topUpMessages.hero.viewAll}</Link>
          </div>
          <p className="pc-hint">{topUpMessages.hero.pendingIntro}</p>
          <ul className="pc-topup-pending-list">
            {transfers.map((transfer) => (
              <li key={transfer.id}>
                <Link
                  className="pc-topup-pending-item"
                  href={`/${locale}/balance/top-ups/${transfer.id}`}
                >
                  <MethodMark method={transfer.paymentMethod} locale={locale} size={32} />
                  <span className="pc-topup-pending-name">
                    {methodName(transfer.paymentMethod, locale)}
                    {transfer.reference === null ? null : (
                      <span className="pc-hint pc-ltr" dir="ltr">
                        {transfer.reference}
                      </span>
                    )}
                  </span>
                  {transfer.amount.minorUnits === '0' ? null : (
                    <TopUpAmount amount={transfer.amount} locale={locale} />
                  )}
                  <TopUpStatusBadge status={transfer.status} locale={locale} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <TransactionHistory
            entries={entries}
            locale={locale}
            hasMore={nextCursor !== null}
            onLoadMore={() => void loadMore()}
          />
        </div>

        <aside className="pc-detail-side">
          {/* The card payment provider, exactly as before. Only offered when a
              provider can actually take the payment; when it cannot, the page
              says so instead of showing a control that could only fail
              (Checkpoint 20.8). */}
          {paymentsAvailable && defaultCurrency !== undefined ? (
            <AddCreditPanel
              locale={locale}
              currencies={currencies}
              defaultCurrency={defaultCurrency}
            />
          ) : (
            <AddCreditUnavailable locale={locale} />
          )}

          {canWithdraw && defaultCurrency !== undefined ? (
            <WithdrawCard currency={defaultCurrency} locale={locale} />
          ) : null}

          <HoldList holds={holds} locale={locale} />
          <TopUpHistory topUps={topUps} locale={locale} />

          <RefundList refunds={refunds} locale={locale} />
          <p className="pc-hint">{messages.refundInitiatedByPalCert}</p>
        </aside>
      </div>
    </main>
  );
}
