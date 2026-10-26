'use client';

import { DataTable } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { useCallback, useEffect, useId, useState } from 'react';
import { getBalanceMessages } from '@/i18n/balance-messages';
import type { Locale } from '@/i18n/locales';
import {
  ApiError,
  balanceApi,
  type BalanceSummaryResponse,
  type BalanceTopUpResponse,
  type CreditHoldResponse,
  type LedgerEntryResponse,
  type MoneyResponse,
  type PaymentRefundResponse,
} from '@/lib/api-client';
import { formatMoney, isNegative, toMinorUnits } from '@/lib/money';

/** The slice of the client these panels use, so a test can supply its own. */
export type BalanceApi = Pick<
  typeof balanceApi,
  | 'balance'
  | 'currencies'
  | 'transactions'
  | 'holds'
  | 'topUps'
  | 'topUp'
  | 'refunds'
  | 'createTopUp'
>;

/** Where the browser remembers which top-up it walked away to pay for. */
export const RETURN_TOPUP_KEY = 'palcert.balance.pending-top-up';

function describe(caught: unknown, locale: Locale): string {
  const messages = getBalanceMessages(locale);
  return caught instanceof ApiError
    ? (messages.errors[caught.code] ?? messages.genericError)
    : messages.genericError;
}

export function Amount({ amount, locale }: { amount: MoneyResponse; locale: Locale }) {
  // The exact minor units travel in the DOM next to the formatted string, so a
  // reader who needs the unrounded figure — or a test — can always find it.
  return (
    <span data-minor-units={amount.minorUnits} data-currency={amount.currency}>
      {formatMoney(amount, locale)}
    </span>
  );
}

/**
 * What the customer has, and what is set aside (§62, §114).
 *
 * Available and reserved are shown as two separate figures rather than one
 * net number, because "you have 20 but 4 is spoken for" is the only honest
 * description of a balance with a hold against it.
 */
export function BalanceSummaryCard({
  summary,
  locale,
}: {
  readonly summary: BalanceSummaryResponse;
  readonly locale: Locale;
}) {
  const messages = getBalanceMessages(locale);
  const negative = isNegative(summary.available.minorUnits);

  return (
    <section className="pc-card" aria-label={messages.title}>
      <dl className="pc-summary">
        <div>
          <dt>{messages.available}</dt>
          <dd>
            <Amount amount={summary.available} locale={locale} />
          </dd>
          <p className="pc-hint">{messages.availableHint}</p>
        </div>
        <div>
          <dt>{messages.reserved}</dt>
          <dd>
            <Amount amount={summary.reserved} locale={locale} />
          </dd>
          <p className="pc-hint">{messages.reservedHint}</p>
        </div>
        <div>
          <dt>{messages.cash}</dt>
          <dd>
            <Amount amount={summary.cash} locale={locale} />
          </dd>
        </div>
        <div>
          <dt>{messages.promotional}</dt>
          <dd>
            <Amount amount={summary.promotional} locale={locale} />
          </dd>
          <p className="pc-hint">{messages.promotionalHint}</p>
        </div>
      </dl>

      {negative && (
        <p className="pc-alert" role="status">
          {messages.negativeBalance}
        </p>
      )}
    </section>
  );
}

/**
 * The balance at a glance, with the way to add to it.
 *
 * Available is the headline because it is what a person can spend now; cash,
 * promotional and reserved explain it underneath. The call to action leads to
 * the transfer flow, which never claims to add anything until PalCert finance
 * has verified the transfer.
 */
export function BalanceHero({
  summary,
  locale,
  addHref,
  addLabel,
  addHint,
}: {
  readonly summary: BalanceSummaryResponse;
  readonly locale: Locale;
  readonly addHref: string | null;
  readonly addLabel: string;
  readonly addHint: string;
}) {
  const messages = getBalanceMessages(locale);
  const negative = isNegative(summary.available.minorUnits);
  return (
    <section className="pc-card pc-balance-hero" aria-label={messages.title}>
      <div className="pc-balance-hero-main">
        <div>
          <p className="pc-balance-hero-label">{messages.available}</p>
          <p className="pc-balance-hero-amount">
            <Amount amount={summary.available} locale={locale} />
          </p>
          <p className="pc-hint">{messages.availableHint}</p>
        </div>
        {addHref === null ? null : (
          <div className="pc-balance-hero-action">
            <a className="pc-btn pc-btn-primary" href={addHref}>
              {addLabel}
            </a>
            <p className="pc-hint">{addHint}</p>
          </div>
        )}
      </div>
      <dl className="pc-balance-hero-figures">
        <div>
          <dt>{messages.cash}</dt>
          <dd>
            <Amount amount={summary.cash} locale={locale} />
          </dd>
        </div>
        <div>
          <dt>{messages.promotional}</dt>
          <dd>
            <Amount amount={summary.promotional} locale={locale} />
          </dd>
          <dd className="pc-hint">{messages.promotionalHint}</dd>
        </div>
        <div>
          <dt>{messages.reserved}</dt>
          <dd>
            <Amount amount={summary.reserved} locale={locale} />
          </dd>
          <dd className="pc-hint">{messages.reservedHint}</dd>
        </div>
      </dl>
      {negative && (
        <p className="pc-alert" role="status">
          {messages.negativeBalance}
        </p>
      )}
    </section>
  );
}

/**
 * Adding credit (§91, §115).
 *
 * Two steps on purpose. The customer types an amount, then reads back exactly
 * what will be charged before anything leaves PalCert — and the button that
 * leaves says where it is going and that PalCert will not see the card.
 *
 * The amount is turned into minor units by string arithmetic, and the server
 * is the one that decides whether it is within the limits.
 */
export function AddCreditPanel({
  locale,
  currencies,
  defaultCurrency,
  api = balanceApi,
  redirect = (url: string) => {
    window.location.assign(url);
  },
}: {
  readonly locale: Locale;
  readonly currencies: readonly string[];
  readonly defaultCurrency: string;
  readonly api?: BalanceApi;
  readonly redirect?: (url: string) => void;
}) {
  const messages = getBalanceMessages(locale);
  const amountId = useId();
  const hintId = useId();
  const currencyId = useId();

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minorUnits = toMinorUnits(amount, currency);

  function review(): void {
    if (minorUnits === null || minorUnits === '0') {
      setError(messages.amountInvalid);
      return;
    }
    setError(null);
    setReviewing(true);
  }

  async function start(): Promise<void> {
    if (minorUnits === null) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createTopUp(
        { currency, amountMinorUnits: minorUnits },
        crypto.randomUUID(),
      );
      // Remembered before leaving, so the page the provider redirects back to
      // knows which top-up to *ask the server about*. It is a lookup key and
      // nothing more: the redirect itself never credits anything (§40).
      try {
        window.sessionStorage.setItem(RETURN_TOPUP_KEY, created.topUp.id);
      } catch {
        // A browser that refuses session storage still completes the payment;
        // the return page simply falls back to showing the latest top-up.
      }
      redirect(created.checkoutUrl);
    } catch (caught) {
      setError(describe(caught, locale));
      setBusy(false);
    }
  }

  return (
    <section className="pc-card" aria-label={messages.addCredit}>
      <h2>{messages.addCredit}</h2>

      {reviewing ? (
        <div>
          <p>{messages.reviewTitle}</p>
          <p className="pc-review-amount">
            {messages.reviewAmount}{' '}
            <Amount amount={{ currency, minorUnits: minorUnits ?? '0' }} locale={locale} />
          </p>
          <p className="pc-hint">{messages.continueHint}</p>
          {error !== null && (
            <p className="pc-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" onClick={() => void start()} disabled={busy}>
            {busy ? messages.redirecting : messages.continueToPayment}
          </button>
          <button type="button" onClick={() => setReviewing(false)} disabled={busy}>
            {messages.cancel}
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
        >
          <div className="pc-field">
            <label htmlFor={amountId}>{messages.amountLabel}</label>
            <input
              id={amountId}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-describedby={hintId}
              aria-invalid={error !== null}
              required
            />
            <p id={hintId} className="pc-hint">
              {messages.amountHint}
            </p>
          </div>

          <div className="pc-field">
            <label htmlFor={currencyId}>{messages.currencyLabel}</label>
            <select
              id={currencyId}
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>

          {error !== null && (
            <p className="pc-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit">{messages.addCredit}</button>
        </form>
      )}
    </section>
  );
}

/** Provider down: everything except adding credit still works (§110, §111). */
export function AddCreditUnavailable({ locale }: { readonly locale: Locale }) {
  const messages = getBalanceMessages(locale);
  return (
    <section className="pc-card" aria-label={messages.addCredit}>
      <h2>{messages.addCredit}</h2>
      <p role="status">{messages.unavailable}</p>
      <p className="pc-hint">{messages.unavailableHint}</p>
    </section>
  );
}

/** Every movement of credit, in the customer's words rather than the ledger's. */
export function TransactionHistory({
  entries,
  locale,
  hasMore,
  onLoadMore,
}: {
  readonly entries: readonly LedgerEntryResponse[];
  readonly locale: Locale;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
}) {
  const messages = getBalanceMessages(locale);

  if (entries.length === 0) {
    return (
      <section className="pc-card" aria-label={messages.transactions}>
        <h2>{messages.transactions}</h2>
        <p>{messages.noTransactions}</p>
      </section>
    );
  }

  return (
    <section className="pc-card" aria-label={messages.transactions}>
      <h2>{messages.transactions}</h2>
      <DataTable
        caption={messages.transactions}
        rows={entries}
        rowKey={(entry) => entry.publicId}
        columns={[
          {
            key: 'activity',
            header: messages.columnActivity,
            primary: true,
            cell: (entry) => (
              <>
                {messages.entryTypes[entry.entryType] ?? entry.entryType}
                {entry.reversalOfEntryId !== null && (
                  <span className="pc-hint"> {messages.reversalNote}</span>
                )}
              </>
            ),
          },
          {
            key: 'amount',
            header: messages.columnAmount,
            align: 'end',
            cell: (entry) => <Amount amount={entry.amount} locale={locale} />,
          },
          {
            key: 'when',
            header: messages.columnWhen,
            cell: (entry) => (
              <span className="pc-cell-stack">
                {entry.serviceProductCode === undefined ||
                entry.serviceProductCode === null ||
                messages.serviceProducts[entry.serviceProductCode] === undefined ? null : (
                  <strong data-testid="ledger-service-product">
                    {messages.serviceProducts[entry.serviceProductCode]}
                  </strong>
                )}
                {entry.reasonCode === null ? null : (
                  <span>{messages.reasonCodes[entry.reasonCode] ?? entry.reasonCode}</span>
                )}
                <time className="pc-hint" dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleString(locale)}
                </time>
              </span>
            ),
          },
        ]}
      />
      {hasMore && (
        <button type="button" className="secondary" onClick={onLoadMore}>
          {messages.loadMore}
        </button>
      )}
    </section>
  );
}

/** Top-ups, including the ones that did not work and why. */
export function TopUpHistory({
  topUps,
  locale,
}: {
  readonly topUps: readonly BalanceTopUpResponse[];
  readonly locale: Locale;
}) {
  const messages = getBalanceMessages(locale);

  return (
    <section className="pc-card" aria-label={messages.pendingTopUps}>
      <h2>{messages.pendingTopUps}</h2>
      {topUps.length === 0 ? (
        <p>{messages.noTopUps}</p>
      ) : (
        <ul className="pc-list">
          {topUps.map((topUp) => (
            <li key={topUp.id}>
              <Amount amount={topUp.amount} locale={locale} />{' '}
              <StatusBadge
                status={topUp.status}
                label={messages.topUpStatuses[topUp.status] ?? topUp.status}
              />
              {topUp.failureCode !== null && (
                <p className="pc-hint">
                  {messages.topUpFailureCodes[topUp.failureCode] ?? messages.genericError}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What is currently set aside, and for what. */
export function HoldList({
  holds,
  locale,
}: {
  readonly holds: readonly CreditHoldResponse[];
  readonly locale: Locale;
}) {
  const messages = getBalanceMessages(locale);

  return (
    <section className="pc-card" aria-label={messages.holds}>
      <h2>{messages.holds}</h2>
      {holds.length === 0 ? (
        <p>{messages.noHolds}</p>
      ) : (
        <ul className="pc-list">
          {holds.map((hold) => (
            <li key={hold.id}>
              <Amount amount={hold.amount} locale={locale} />{' '}
              <StatusBadge
                status={hold.status}
                label={messages.holdStatuses[hold.status] ?? hold.status}
              />{' '}
              <span className="pc-hint">{messages.holdPurposes[hold.purpose] ?? hold.purpose}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Money on its way back to a card, which only PalCert can start (§72, §95). */
export function RefundList({
  refunds,
  locale,
}: {
  readonly refunds: readonly PaymentRefundResponse[];
  readonly locale: Locale;
}) {
  const messages = getBalanceMessages(locale);

  return (
    <section className="pc-card" aria-label={messages.refunds}>
      <h2>{messages.refunds}</h2>
      {refunds.length === 0 ? (
        <p>{messages.noRefunds}</p>
      ) : (
        <ul className="pc-list">
          {refunds.map((refund) => (
            <li key={refund.id}>
              <Amount amount={refund.amount} locale={locale} />{' '}
              <StatusBadge
                status={refund.status}
                label={messages.refundStatuses[refund.status] ?? refund.status}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The page the payment provider sends the browser back to (§40, §91).
 *
 * It credits nothing and claims nothing. It asks the server what the top-up's
 * status actually is, and shows that — so a customer who forges this URL, or
 * who arrives after a payment that later fails, is told the truth. Until the
 * server says the payment was verified, the page says PalCert is confirming.
 */
export function PaymentReturnPanel({
  locale,
  api = balanceApi,
  pollMs = 3000,
  attempts = 10,
}: {
  readonly locale: Locale;
  readonly api?: BalanceApi;
  readonly pollMs?: number;
  readonly attempts?: number;
}) {
  const messages = getBalanceMessages(locale);
  const [topUp, setTopUp] = useState<BalanceTopUpResponse | null>(null);
  const [settled, setSettled] = useState(false);

  const look = useCallback(async (): Promise<boolean> => {
    let id: string | null = null;
    try {
      id = window.sessionStorage.getItem(RETURN_TOPUP_KEY);
    } catch {
      id = null;
    }

    try {
      const found = id === null ? ((await api.topUps())[0] ?? null) : await api.topUp(id);
      setTopUp(found);
      // Only the server's own terminal states end the wait. A redirect is not
      // one of them.
      const done =
        found !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(found.status);
      if (done) setSettled(true);
      return done;
    } catch {
      return false;
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      const done = await look();
      tries += 1;
      if (cancelled || done || tries >= attempts) return;
      timer = setTimeout(() => void tick(), pollMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [look, pollMs, attempts]);

  const succeeded = topUp?.status === 'SUCCEEDED';
  const failed = settled && !succeeded;

  return (
    <section className="pc-card" aria-label={messages.returnTitle}>
      <h1 className="pc-title">{messages.returnTitle}</h1>
      <p role="status">
        {succeeded
          ? messages.returnAdded
          : failed
            ? messages.returnFailed
            : messages.returnConfirming}
      </p>
      {!settled && <p className="pc-hint">{messages.returnNotYetCredited}</p>}
      {topUp !== null && (
        <p>
          <Amount amount={topUp.amount} locale={locale} />{' '}
          <StatusBadge
            status={topUp.status}
            label={messages.topUpStatuses[topUp.status] ?? topUp.status}
          />
        </p>
      )}
    </section>
  );
}
