'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getAIBillingMessages } from '@/i18n/ai-billing-messages';
import type { Locale } from '@/i18n/locales';
import {
  ApiError,
  balanceApi,
  type MoneyResponse,
  type PriceQuoteResponse,
} from '@/lib/api-client';
import { formatMoney } from '@/lib/money';

/**
 * The fee for one AI service, shown before the user confirms (ADR-0149).
 *
 * Every paid AI action uses this: it asks the server for a quote — the client
 * never states a price — shows the amount and the "charged only on success"
 * promise, compares it with the available balance, and offers Add balance
 * when it does not fit. A quote funds one run, so the owner of the button
 * calls `refresh()` after starting one.
 */
export type AIServiceProduct = 'AI_REVIEW' | 'AI_RULE_EXTRACTION';

export type AIServiceFeeApi = {
  readonly quote: typeof balanceApi.quote;
  readonly balance: typeof balanceApi.balance;
};

const DEFAULT_API: AIServiceFeeApi = { quote: balanceApi.quote, balance: balanceApi.balance };

export interface AIServiceQuoteState {
  readonly quote: PriceQuoteResponse | null;
  readonly available: MoneyResponse | null;
  /** True when the balance does not cover the fee. */
  readonly short: boolean;
  /** True when no active price exists in the balance currency. */
  readonly unavailable: boolean;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

export function useAIServiceQuote(
  product: AIServiceProduct,
  api: AIServiceFeeApi = DEFAULT_API,
): AIServiceQuoteState {
  const [quote, setQuote] = useState<PriceQuoteResponse | null>(null);
  const [available, setAvailable] = useState<MoneyResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const priced = await api.quote(product);
      setQuote(priced);
      setUnavailable(false);
      const balance = await api.balance(priced.amount.currency);
      setAvailable(balance.available);
    } catch (caught) {
      setQuote(null);
      if (
        caught instanceof ApiError &&
        (caught.code === 'PRICE_NOT_AVAILABLE' || caught.code === 'SERVICE_PRODUCT_NOT_ACTIVE')
      ) {
        setUnavailable(true);
      }
    } finally {
      setLoading(false);
    }
  }, [api, product]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const short =
    quote !== null &&
    available !== null &&
    BigInt(available.minorUnits) < BigInt(quote.amount.minorUnits);

  return { quote, available, short, unavailable, loading, refresh };
}

export function AIServiceFee({
  state,
  locale,
  organizationScoped = false,
}: {
  state: AIServiceQuoteState;
  locale: Locale;
  organizationScoped?: boolean;
}): React.JSX.Element {
  const messages = getAIBillingMessages(locale);
  if (state.unavailable) {
    return (
      <div className="pc-ai-fee" data-testid="ai-fee" data-state="unavailable">
        <p role="alert">{messages.unavailable}</p>
      </div>
    );
  }
  if (state.quote === null) {
    return (
      <div className="pc-ai-fee" data-testid="ai-fee" data-state="loading">
        <p className="pc-hint">{state.loading ? messages.loading : ''}</p>
      </div>
    );
  }
  const price = formatMoney(state.quote.amount, locale);
  return (
    <div className="pc-ai-fee" data-testid="ai-fee" data-state={state.short ? 'short' : 'ready'}>
      <p className="pc-ai-fee-title">
        <strong>{messages.feeTitle}</strong>
      </p>
      <p className="pc-ai-fee-amount">
        {messages.fee}: <bdi data-testid="ai-fee-amount">{price}</bdi>
      </p>
      <p className="pc-hint">{messages.chargedOnSuccess}</p>
      <p className="pc-hint">{messages.releasedOnFailure}</p>
      {organizationScoped && (
        <p className="pc-ai-fee-org" data-testid="ai-fee-org-notice">
          {messages.organizationNotice}
        </p>
      )}
      {state.short && (
        <p role="alert" className="pc-ai-fee-short" data-testid="ai-fee-short">
          <strong>{messages.insufficient}</strong>
          {state.available !== null && (
            <>
              {' · '}
              {messages.available}: <bdi>{formatMoney(state.available, locale)}</bdi>
            </>
          )}{' '}
          <Link href={`/${locale}/balance/add`} className="pc-btn pc-btn-secondary pc-btn-sm">
            {messages.addBalance}
          </Link>
        </p>
      )}
    </div>
  );
}
