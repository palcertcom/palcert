'use client';

import { StatusBadge } from '@/components/ui/status-badge';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getBillingMessages } from '@/i18n/billing-messages';
import type { Locale } from '@/i18n/locales';
import {
  ApiError,
  balanceApi,
  checksApi,
  type CheckResponse,
  type MoneyResponse,
  type PriceQuoteResponse,
  type ServiceBillingResponse,
} from '@/lib/api-client';
import { formatMoney } from '@/lib/money';

/** The slice of the client these components use, so a test can supply its own. */
export type BillingApi = {
  readonly quote: typeof balanceApi.quote;
  readonly balance: typeof balanceApi.balance;
  readonly cancel: typeof checksApi.cancel;
};

const DEFAULT_API: BillingApi = {
  quote: balanceApi.quote,
  balance: balanceApi.balance,
  cancel: checksApi.cancel,
};

function describe(caught: unknown, locale: Locale): string {
  const messages = getBillingMessages(locale);
  return caught instanceof ApiError
    ? (messages.errors[caught.code] ?? caught.message)
    : 'Something went wrong. Please try again.';
}

function minus(a: MoneyResponse, b: MoneyResponse): MoneyResponse {
  // Integer minor units, subtracted as integers. There is no other kind of
  // arithmetic on money in this application (Phase 10 §4).
  return {
    currency: a.currency,
    minorUnits: (BigInt(a.minorUnits) - BigInt(b.minorUnits)).toString(),
  };
}

function atLeast(money: MoneyResponse, other: MoneyResponse): boolean {
  return BigInt(money.minorUnits) >= BigInt(other.minorUnits);
}

/**
 * The price confirmation before a check is bought (§53, §54, §55, §132).
 *
 * It says three things, always together and always in words: what will be
 * reserved, that a charge happens only on successful delivery, and that a
 * failure releases the reservation. A price shown without the second and third
 * sentences would be an honest number in a misleading place.
 *
 * When the balance is short it shows required, available and the shortfall —
 * all three, because "not enough" without a number is not actionable — and
 * offers the balance page. It never starts a top-up itself (§90).
 */
export function CheckPurchasePanel({
  locale,
  onConfirm,
  starting = false,
  api = DEFAULT_API,
}: {
  readonly locale: Locale;
  readonly onConfirm: (priceQuoteId: string) => void;
  readonly starting?: boolean;
  readonly api?: BillingApi;
}) {
  const messages = getBillingMessages(locale);
  const [quote, setQuote] = useState<PriceQuoteResponse | null>(null);
  const [available, setAvailable] = useState<MoneyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const priced = await api.quote('DOCUMENT_CHECK');
      setQuote(priced);
      // The balance is read in the quote's own currency: comparing across
      // currencies would be a conversion, and PalCert performs none (§87).
      setAvailable((await api.balance(priced.amount.currency)).available);
    } catch (caught) {
      setError(describe(caught, locale));
    }
  }, [api, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <section className="pc-card" aria-label={messages.price}>
        <p className="pc-error" role="alert">
          {error}
        </p>
        <button type="button" onClick={() => void load()}>
          {messages.refreshQuote}
        </button>
      </section>
    );
  }

  if (quote === null || available === null) return null;

  const affordable = atLeast(available, quote.amount);
  const price = formatMoney(quote.amount, locale);

  return (
    <section className="pc-card" aria-label={messages.price}>
      <dl className="pc-price-figures">
        <div>
          <dt>{messages.price}</dt>
          <dd>
            <span data-minor-units={quote.amount.minorUnits}>{price}</span>
          </dd>
          <dd className="pc-hint">{messages.priceHint}</dd>
        </div>
        <div>
          <dt>{messages.yourBalance}</dt>
          <dd>
            <span data-minor-units={available.minorUnits}>{formatMoney(available, locale)}</span>
          </dd>
        </div>
      </dl>

      <p className="pc-hint">
        {messages.quoteExpires} {new Date(quote.expiresAt).toLocaleString(locale)}
      </p>

      {quote.expired ? (
        <div>
          <p role="alert">{messages.quoteExpired}</p>
          <button type="button" onClick={() => void load()}>
            {messages.refreshQuote}
          </button>
        </div>
      ) : affordable ? (
        <div>
          {/* The three sentences of §54, together and in this order. */}
          <p>{messages.willReserve(price)}</p>
          <p>{messages.chargedOnDelivery}</p>
          <p>{messages.releasedIfIncomplete}</p>
          <button type="button" onClick={() => onConfirm(quote.id)} disabled={starting}>
            {messages.confirmAndStart}
          </button>
        </div>
      ) : (
        <div role="alert">
          <p>{messages.notEnough}</p>
          <ul className="pc-list">
            <li>
              {messages.required}: <span>{price}</span>
            </li>
            <li>
              {messages.available}: <span>{formatMoney(available, locale)}</span>
            </li>
            <li>
              {messages.shortfall}:{' '}
              <span>{formatMoney(minus(quote.amount, available), locale)}</span>
            </li>
          </ul>
          <Link href={`/${locale}/balance`}>{messages.addCredit}</Link>
        </div>
      )}
    </section>
  );
}

/**
 * What one check cost, wherever a check is shown (§58–§63).
 *
 * The wording changes with the state rather than the colour, and a released
 * reservation is never called a refund — nothing was taken, so there is
 * nothing to refund (§60, §133, §134).
 */
export function CheckBillingSummary({
  check,
  locale,
}: {
  readonly check: Pick<CheckResponse, 'billing' | 'legacyFree'>;
  readonly locale: Locale;
}) {
  const messages = getBillingMessages(locale);

  if (check.billing === null) {
    return (
      <p className="pc-billing" data-billing="LEGACY_FREE">
        {messages.legacyFree}
      </p>
    );
  }

  const billing: ServiceBillingResponse = check.billing;
  const label = messages.statuses[billing.status] ?? billing.status;
  const charged = BigInt(billing.charged.minorUnits) > 0n;
  const amount = formatMoney(charged ? billing.charged : billing.amount, locale);

  return (
    <div className="pc-billing" data-billing={billing.status}>
      <p>
        <StatusBadge status={billing.status} label={label} />{' '}
        <span data-minor-units={(charged ? billing.charged : billing.amount).minorUnits}>
          {amount}
        </span>
      </p>

      {billing.status === 'RELEASED' && (
        <p className="pc-hint">
          {messages.noChargeMade} {messages.reservationReturned}
        </p>
      )}
      {billing.failureCode !== null && (
        <p className="pc-hint">{messages.failureCodes[billing.failureCode] ?? ''}</p>
      )}
      {charged && <Link href={`/${locale}/balance`}>{messages.viewBalance}</Link>}
    </div>
  );
}

/**
 * Stopping a check that has not been delivered (§43, §61).
 *
 * Offered only while there is something to stop. Once a report exists the
 * service has been delivered, and a button that promised otherwise would be
 * a lie the server would then refuse.
 */
export function CancelCheckButton({
  checkId,
  status,
  locale,
  onCancelled,
  api = DEFAULT_API,
}: {
  readonly checkId: string;
  readonly status: string;
  readonly locale: Locale;
  readonly onCancelled?: (check: CheckResponse) => void;
  readonly api?: BillingApi;
}) {
  const messages = getBillingMessages(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancellable = ['CREATED', 'WAITING_ANALYSIS', 'EVALUATING', 'GENERATING_REPORT'].includes(
    status,
  );
  if (!cancellable) return null;

  async function cancel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const cancelled = await api.cancel(checkId);
      onCancelled?.(cancelled);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={() => void cancel()} disabled={busy}>
        {busy ? messages.cancelling : messages.cancelCheck}
      </button>
      <p className="pc-hint">{messages.cancelHint}</p>
      {error !== null && (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
