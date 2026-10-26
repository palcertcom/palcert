import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AddCreditPanel,
  AddCreditUnavailable,
  BalanceSummaryCard,
  HoldList,
  PaymentReturnPanel,
  RefundList,
  RETURN_TOPUP_KEY,
  TopUpHistory,
  TransactionHistory,
  type BalanceApi,
} from '../balance-panels';
import { getBalanceMessages } from '@/i18n/balance-messages';
import type * as ApiClient from '@/lib/api-client';
import type {
  BalanceSummaryResponse,
  BalanceTopUpResponse,
  CreditHoldResponse,
  LedgerEntryResponse,
  PaymentRefundResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;
const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getBalanceMessages('en');
const ar = getBalanceMessages('ar');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(overrides: Partial<BalanceSummaryResponse> = {}): BalanceSummaryResponse {
  return {
    currency: 'USD',
    available: { currency: 'USD', minorUnits: '1625' },
    reserved: { currency: 'USD', minorUnits: '400' },
    cash: { currency: 'USD', minorUnits: '1525' },
    promotional: { currency: 'USD', minorUnits: '500' },
    accounts: [],
    ...overrides,
  };
}

function topUp(overrides: Partial<BalanceTopUpResponse> = {}): BalanceTopUpResponse {
  return {
    id: 'topup-1',
    status: 'PENDING',
    amount: { currency: 'USD', minorUnits: '2000' },
    provider: 'stripe',
    failureCode: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    expiresAt: null,
    succeededAt: null,
    failedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function entry(overrides: Partial<LedgerEntryResponse> = {}): LedgerEntryResponse {
  return {
    publicId: 'entry-1',
    entryType: 'TOP_UP_CREDIT',
    creditClass: 'CASH',
    amount: { currency: 'USD', minorUnits: '2000' },
    reasonCode: 'TOP_UP_VERIFIED',
    reversalOfEntryId: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

function hold(overrides: Partial<CreditHoldResponse> = {}): CreditHoldResponse {
  return {
    id: 'hold-1',
    status: 'ACTIVE',
    purpose: 'SERVICE',
    amount: { currency: 'USD', minorUnits: '400' },
    creditClass: 'CASH',
    expiresAt: '2026-09-01T10:00:00.000Z',
    createdAt: '2026-09-01T09:00:00.000Z',
    capturedAt: null,
    releasedAt: null,
    expiredAt: null,
    ...overrides,
  };
}

function refund(overrides: Partial<PaymentRefundResponse> = {}): PaymentRefundResponse {
  return {
    id: 'refund-1',
    topUpId: 'topup-1',
    status: 'PENDING',
    amount: { currency: 'USD', minorUnits: '1000' },
    reason: 'CUSTOMER_REQUEST',
    failureCode: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    succeededAt: null,
    failedAt: null,
    ...overrides,
  };
}

function api(overrides: Partial<BalanceApi> = {}): BalanceApi {
  return {
    balance: vi.fn(async () => summary()),
    currencies: vi.fn(async () => ['USD']),
    transactions: vi.fn(async () => ({ items: [], nextCursor: null })),
    holds: vi.fn(async () => []),
    topUps: vi.fn(async () => []),
    topUp: vi.fn(async () => topUp()),
    refunds: vi.fn(async () => []),
    createTopUp: vi.fn(async () => ({
      topUp: topUp(),
      checkoutUrl: 'https://provider.test/session',
      expiresAt: '2026-09-01T09:30:00.000Z',
    })),
    ...overrides,
  } as BalanceApi;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('balance summary', () => {
  it('shows available and reserved as separate figures', () => {
    // §114: one net number would hide the fact that some of the balance is
    // already spoken for by a service in progress.
    render(<BalanceSummaryCard summary={summary()} locale="en" />);

    expect(screen.getByText(en.available)).toBeInTheDocument();
    expect(screen.getByText(en.reserved)).toBeInTheDocument();
    expect(screen.getByText('$16.25')).toBeInTheDocument();
    expect(screen.getByText('$4.00')).toBeInTheDocument();
  });

  it('carries the exact minor units alongside the formatted amount', () => {
    // Formatting is presentation; the integer is the truth (§4). It stays in
    // the DOM so no rounding can ever be the only thing a reader sees.
    const { container } = render(<BalanceSummaryCard summary={summary()} locale="en" />);
    expect(container.querySelector('[data-minor-units="1625"]')).not.toBeNull();
  });

  it('tells a customer promotional credit cannot come back as cash', () => {
    // §9.
    render(<BalanceSummaryCard summary={summary()} locale="en" />);
    expect(screen.getByText(en.promotionalHint)).toBeInTheDocument();
  });

  it('explains a negative balance instead of hiding it', () => {
    // §84, §85: a bank reversal can take the balance below zero and PalCert
    // does not invent credit to make that look tidy.
    render(
      <BalanceSummaryCard
        summary={summary({ available: { currency: 'USD', minorUnits: '-500' } })}
        locale="en"
      />,
    );
    expect(screen.getByText(en.negativeBalance)).toBeInTheDocument();
  });

  it('does not show the negative-balance explanation when there is none', () => {
    render(<BalanceSummaryCard summary={summary()} locale="en" />);
    expect(screen.queryByText(en.negativeBalance)).not.toBeInTheDocument();
  });

  it('renders in Arabic when asked', () => {
    render(<BalanceSummaryCard summary={summary()} locale="ar" />);
    expect(screen.getByText(ar.available)).toBeInTheDocument();
    expect(screen.getByText(ar.promotionalHint)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Adding credit
// ---------------------------------------------------------------------------

describe('adding credit', () => {
  it('asks the customer to confirm the amount before leaving PalCert', async () => {
    const client = api();
    render(<AddCreditPanel locale="en" currencies={['USD']} defaultCurrency="USD" api={client} />);

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));

    expect(await screen.findByText(en.reviewTitle)).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(client.createTopUp).not.toHaveBeenCalled();
  });

  it('says the card details are entered on the provider’s page, not PalCert’s', () => {
    // §38: PalCert holds no card data, and says so where it matters.
    render(<AddCreditPanel locale="en" currencies={['USD']} defaultCurrency="USD" api={api()} />);
    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));

    expect(screen.getByText(en.continueHint)).toBeInTheDocument();
  });

  it('converts the typed amount to minor units without floating-point arithmetic', async () => {
    // §4, §5: "20.50" becomes 2050, by string arithmetic, once, here.
    const client = api();
    const redirect = vi.fn();
    render(
      <AddCreditPanel
        locale="en"
        currencies={['USD']}
        defaultCurrency="USD"
        api={client}
        redirect={redirect}
      />,
    );

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '20.50' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));
    fireEvent.click(await screen.findByRole('button', { name: en.continueToPayment }));

    await waitFor(() => expect(client.createTopUp).toHaveBeenCalled());
    expect(vi.mocked(client.createTopUp).mock.calls[0]?.[0]).toEqual({
      currency: 'USD',
      amountMinorUnits: '2050',
    });
  });

  it('sends an idempotency key with every top-up it starts', async () => {
    // §35: a double-clicked button must not become two payments.
    const client = api();
    render(
      <AddCreditPanel
        locale="en"
        currencies={['USD']}
        defaultCurrency="USD"
        api={client}
        redirect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));
    fireEvent.click(await screen.findByRole('button', { name: en.continueToPayment }));

    await waitFor(() => expect(client.createTopUp).toHaveBeenCalled());
    expect(vi.mocked(client.createTopUp).mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('refuses an amount with more precision than the currency has', () => {
    // "20.999" in USD is not a rounding opportunity; it is an error (§4).
    const client = api();
    render(<AddCreditPanel locale="en" currencies={['USD']} defaultCurrency="USD" api={client} />);

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '20.999' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));

    expect(screen.getByRole('alert')).toHaveTextContent(en.amountInvalid);
    expect(client.createTopUp).not.toHaveBeenCalled();
  });

  it('refuses zero', () => {
    const client = api();
    render(<AddCreditPanel locale="en" currencies={['USD']} defaultCurrency="USD" api={client} />);

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));

    expect(screen.getByRole('alert')).toHaveTextContent(en.amountInvalid);
    expect(client.createTopUp).not.toHaveBeenCalled();
  });

  it('shows the server’s reason when a top-up is refused, in the customer’s words', async () => {
    const client = api({
      createTopUp: vi.fn(async () => {
        throw new ApiError('TOPUP_AMOUNT_OUT_OF_RANGE', 'out of range', 422);
      }),
    });
    render(
      <AddCreditPanel
        locale="en"
        currencies={['USD']}
        defaultCurrency="USD"
        api={client}
        redirect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));
    fireEvent.click(await screen.findByRole('button', { name: en.continueToPayment }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      en.errors.TOPUP_AMOUNT_OUT_OF_RANGE ?? '',
    );
  });

  it('remembers the top-up id before leaving, and sends the browser to the provider', async () => {
    const client = api();
    const redirect = vi.fn();
    render(
      <AddCreditPanel
        locale="en"
        currencies={['USD']}
        defaultCurrency="USD"
        api={client}
        redirect={redirect}
      />,
    );

    fireEvent.change(screen.getByLabelText(en.amountLabel), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: en.addCredit }));
    fireEvent.click(await screen.findByRole('button', { name: en.continueToPayment }));

    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://provider.test/session'));
    expect(window.sessionStorage.getItem(RETURN_TOPUP_KEY)).toBe('topup-1');
  });

  it('says only that adding credit is unavailable, never that the balance is', () => {
    // §110, §111: a provider outage is not a PalCert outage.
    render(<AddCreditUnavailable locale="en" />);
    expect(screen.getByText(en.unavailable)).toBeInTheDocument();
    expect(screen.getByText(en.unavailableHint)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The return page
// ---------------------------------------------------------------------------

describe('the page the provider redirects back to', () => {
  it('never says credit was added just because the browser came back', async () => {
    // §40, the single most important rule in the phase. The server still says
    // PENDING, so the page says PalCert is confirming — nothing more.
    window.sessionStorage.setItem(RETURN_TOPUP_KEY, 'topup-1');
    const client = api({ topUp: vi.fn(async () => topUp({ status: 'PENDING' })) });

    render(<PaymentReturnPanel locale="en" api={client} attempts={1} />);

    expect(await screen.findByText(en.returnConfirming)).toBeInTheDocument();
    expect(screen.queryByText(en.returnAdded)).not.toBeInTheDocument();
    expect(screen.getByText(en.returnNotYetCredited)).toBeInTheDocument();
  });

  it('says credit was added only once the server says the top-up succeeded', async () => {
    window.sessionStorage.setItem(RETURN_TOPUP_KEY, 'topup-1');
    const client = api({ topUp: vi.fn(async () => topUp({ status: 'SUCCEEDED' })) });

    render(<PaymentReturnPanel locale="en" api={client} attempts={1} />);

    expect(await screen.findByText(en.returnAdded)).toBeInTheDocument();
    expect(screen.queryByText(en.returnNotYetCredited)).not.toBeInTheDocument();
  });

  it('reports a failed payment truthfully', async () => {
    window.sessionStorage.setItem(RETURN_TOPUP_KEY, 'topup-1');
    const client = api({ topUp: vi.fn(async () => topUp({ status: 'FAILED' })) });

    render(<PaymentReturnPanel locale="en" api={client} attempts={1} />);

    expect(await screen.findByText(en.returnFailed)).toBeInTheDocument();
  });

  it('keeps asking the server while the top-up is still open', async () => {
    window.sessionStorage.setItem(RETURN_TOPUP_KEY, 'topup-1');
    const client = api({ topUp: vi.fn(async () => topUp({ status: 'PENDING' })) });

    render(<PaymentReturnPanel locale="en" api={client} pollMs={1} attempts={3} />);

    await waitFor(() => expect(client.topUp).toHaveBeenCalledTimes(3));
    expect(screen.getByText(en.returnConfirming)).toBeInTheDocument();
  });

  it('stops asking once the server reaches a terminal state', async () => {
    window.sessionStorage.setItem(RETURN_TOPUP_KEY, 'topup-1');
    const client = api({ topUp: vi.fn(async () => topUp({ status: 'SUCCEEDED' })) });

    render(<PaymentReturnPanel locale="en" api={client} pollMs={1} attempts={5} />);

    await screen.findByText(en.returnAdded);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.topUp).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('history', () => {
  it('names every entry type in the customer’s words, never as a raw code', () => {
    render(
      <TransactionHistory
        entries={[
          entry(),
          entry({
            publicId: 'e2',
            entryType: 'SERVICE_CHARGE',
            amount: { currency: 'USD', minorUnits: '-100' },
            reasonCode: 'SERVICE_CAPTURED',
          }),
          entry({
            publicId: 'e3',
            entryType: 'CHARGEBACK_DEBIT',
            amount: { currency: 'USD', minorUnits: '-2000' },
            reasonCode: 'PROVIDER_DISPUTE',
          }),
        ]}
        locale="en"
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.getByText(en.entryTypes.TOP_UP_CREDIT ?? '')).toBeInTheDocument();
    expect(screen.getByText(en.entryTypes.SERVICE_CHARGE ?? '')).toBeInTheDocument();
    expect(screen.getByText(en.entryTypes.CHARGEBACK_DEBIT ?? '')).toBeInTheDocument();
    expect(screen.queryByText('TOP_UP_CREDIT')).not.toBeInTheDocument();
  });

  it('names the AI service an entry paid for, in both languages, never as a code', () => {
    const entries = [
      entry({
        publicId: 'ai-1',
        entryType: 'SERVICE_CHARGE',
        amount: { currency: 'USD', minorUnits: '-50' },
        reasonCode: 'SERVICE_CAPTURED',
        serviceProductCode: 'AI_REVIEW',
      }),
      entry({
        publicId: 'ai-2',
        entryType: 'SERVICE_CHARGE',
        amount: { currency: 'USD', minorUnits: '-200' },
        reasonCode: 'SERVICE_CAPTURED',
        serviceProductCode: 'AI_RULE_EXTRACTION',
      }),
    ];
    const { unmount } = render(
      <TransactionHistory entries={entries} locale="en" hasMore={false} onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('AI review')).toBeInTheDocument();
    expect(screen.getByText('AI rule extraction')).toBeInTheDocument();
    expect(screen.queryByText('AI_REVIEW')).not.toBeInTheDocument();
    unmount();
    render(
      <TransactionHistory entries={entries} locale="ar" hasMore={false} onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('مراجعة بالذكاء الاصطناعي')).toBeInTheDocument();
    expect(screen.getByText('استخراج القواعد بالذكاء الاصطناعي')).toBeInTheDocument();
    expect(screen.queryByText('AI_RULE_EXTRACTION')).not.toBeInTheDocument();
  });

  it('marks a correcting entry as a correction rather than deleting the original', () => {
    // §3, §12: the ledger never loses an entry; a mistake is corrected by a
    // second entry, and the history says which one that is.
    render(
      <TransactionHistory
        entries={[entry({ entryType: 'ADMIN_DEBIT', reversalOfEntryId: 'entry-0' })]}
        locale="en"
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(en.reversalNote)).toBeInTheDocument();
  });

  it('offers more history only when there is more', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <TransactionHistory
        entries={[entry()]}
        locale="en"
        hasMore={false}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.queryByRole('button', { name: en.loadMore })).not.toBeInTheDocument();

    rerender(
      <TransactionHistory entries={[entry()]} locale="en" hasMore onLoadMore={onLoadMore} />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('says why a top-up did not work', () => {
    render(
      <TopUpHistory
        topUps={[topUp({ status: 'FAILED', failureCode: 'PROVIDER_DECLINED' })]}
        locale="en"
      />,
    );
    expect(screen.getByText(en.topUpStatuses.FAILED ?? '')).toBeInTheDocument();
    expect(screen.getByText(en.topUpFailureCodes.PROVIDER_DECLINED ?? '')).toBeInTheDocument();
  });

  it('gives every status a word, not only a colour', () => {
    // §116: the badge carries a data attribute for styling, and text for
    // everyone who cannot use the styling.
    const { container } = render(<TopUpHistory topUps={[topUp()]} locale="en" />);
    const badge = container.querySelector('[data-status="PENDING"]');
    expect(badge?.textContent).toBe(en.topUpStatuses.PENDING);
  });

  it('shows what a hold is for, and that it is not yet spent', () => {
    render(<HoldList holds={[hold()]} locale="en" />);
    expect(screen.getByText(en.holdStatuses.ACTIVE ?? '')).toBeInTheDocument();
    expect(screen.getByText(en.holdPurposes.SERVICE ?? '')).toBeInTheDocument();
  });

  it('offers no button that starts a refund to a card', () => {
    // §72, §95: an external refund is PalCert's act, not a self-service one.
    render(<RefundList refunds={[refund()]} locale="en" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(en.refundStatuses.PENDING ?? '')).toBeInTheDocument();
  });

  it('says plainly when there is nothing to show', () => {
    render(<TransactionHistory entries={[]} locale="en" hasMore={false} onLoadMore={vi.fn()} />);
    expect(screen.getByText(en.noTransactions)).toBeInTheDocument();

    render(<HoldList holds={[]} locale="en" />);
    expect(screen.getByText(en.noHolds)).toBeInTheDocument();

    render(<RefundList refunds={[]} locale="en" />);
    expect(screen.getByText(en.noRefunds)).toBeInTheDocument();
  });
});
