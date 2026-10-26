import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CancelCheckButton,
  CheckBillingSummary,
  CheckPurchasePanel,
  type BillingApi,
} from '../check-billing';
import { getBillingMessages } from '@/i18n/billing-messages';
import type * as ApiClient from '@/lib/api-client';
import type { CheckResponse, ServiceBillingResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;
const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getBillingMessages('en');
const ar = getBillingMessages('ar');

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function quote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quote-1',
    productCode: 'DOCUMENT_CHECK',
    amount: { currency: 'USD', minorUnits: '300' },
    createdAt: '2026-09-14T09:00:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z',
    expired: false,
    ...overrides,
  };
}

function billing(overrides: Partial<ServiceBillingResponse> = {}): ServiceBillingResponse {
  return {
    purchaseId: 'purchase-1',
    productCode: 'DOCUMENT_CHECK',
    status: 'RESERVED',
    amount: { currency: 'USD', minorUnits: '300' },
    reserved: { currency: 'USD', minorUnits: '300' },
    charged: { currency: 'USD', minorUnits: '0' },
    failureCode: null,
    createdAt: '2026-09-14T09:00:00.000Z',
    deliveredAt: null,
    releasedAt: null,
    refundedAt: null,
    ...overrides,
  };
}

function check(
  overrides: Partial<CheckResponse> = {},
): Pick<CheckResponse, 'billing' | 'legacyFree' | 'id' | 'status'> {
  return {
    id: 'check-1',
    status: 'EVALUATING',
    billing: billing(),
    legacyFree: false,
    ...overrides,
  } as Pick<CheckResponse, 'billing' | 'legacyFree' | 'id' | 'status'>;
}

function api(available = '1000', overrides: Partial<BillingApi> = {}): BillingApi {
  return {
    quote: vi.fn(async () => quote()),
    balance: vi.fn(async () => ({
      currency: 'USD',
      available: { currency: 'USD', minorUnits: available },
      reserved: { currency: 'USD', minorUnits: '0' },
      cash: { currency: 'USD', minorUnits: available },
      promotional: { currency: 'USD', minorUnits: '0' },
      accounts: [],
    })),
    cancel: vi.fn(async () => check() as CheckResponse),
    ...overrides,
  } as BillingApi;
}

// ---------------------------------------------------------------------------
// The price confirmation
// ---------------------------------------------------------------------------

describe('the price confirmation before a check is bought', () => {
  it('shows the price, the balance and when the price expires', async () => {
    // §53.
    render(<CheckPurchasePanel locale="en" onConfirm={vi.fn()} api={api()} />);

    expect(await screen.findByText('$3.00')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getByText(en.price)).toBeInTheDocument();
    expect(screen.getByText(en.yourBalance)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.quoteExpires))).toBeInTheDocument();
  });

  it('says all three things about the reservation before offering the button', async () => {
    // §54: what will be reserved, when a charge happens, and what happens if
    // PalCert cannot finish.
    render(<CheckPurchasePanel locale="en" onConfirm={vi.fn()} api={api()} />);

    expect(await screen.findByText(en.willReserve('$3.00'))).toBeInTheDocument();
    expect(screen.getByText(en.chargedOnDelivery)).toBeInTheDocument();
    expect(screen.getByText(en.releasedIfIncomplete)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.confirmAndStart })).toBeInTheDocument();
  });

  it('names the quote, and never an amount, when the customer confirms', async () => {
    // §13: the client asks for a quote by id. There is no field here for a
    // price, and this is what proves it.
    const onConfirm = vi.fn();
    render(<CheckPurchasePanel locale="en" onConfirm={onConfirm} api={api()} />);

    fireEvent.click(await screen.findByRole('button', { name: en.confirmAndStart }));
    expect(onConfirm).toHaveBeenCalledWith('quote-1');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows required, available and the shortfall when the balance is short', async () => {
    // §55.
    render(<CheckPurchasePanel locale="en" onConfirm={vi.fn()} api={api('120')} />);

    expect(await screen.findByText(en.notEnough)).toBeInTheDocument();
    expect(screen.getByText(`${en.required}:`)).toBeInTheDocument();
    expect(screen.getByText(`${en.available}:`)).toBeInTheDocument();
    expect(screen.getByText(`${en.shortfall}:`)).toBeInTheDocument();
    expect(screen.getByText('$1.80')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.addCredit })).toHaveAttribute('href', '/en/balance');
  });

  it('offers no way to start a check it cannot pay for', async () => {
    render(<CheckPurchasePanel locale="en" onConfirm={vi.fn()} api={api('120')} />);
    await screen.findByText(en.notEnough);
    expect(screen.queryByRole('button', { name: en.confirmAndStart })).not.toBeInTheDocument();
  });

  it('never starts a top-up by itself', async () => {
    // §90: adding credit is a separate, deliberate act. This panel links to
    // the balance page and does nothing else.
    const client = api('120');
    render(<CheckPurchasePanel locale="en" onConfirm={vi.fn()} api={client} />);
    await screen.findByText(en.notEnough);

    expect(Object.keys(client)).not.toContain('createTopUp');
    expect(screen.getByRole('link', { name: en.addCredit })).toBeInTheDocument();
  });

  it('refuses to spend an expired price, and offers the current one', async () => {
    // §110.
    render(
      <CheckPurchasePanel
        locale="en"
        onConfirm={vi.fn()}
        api={api('1000', { quote: vi.fn(async () => quote({ expired: true })) })}
      />,
    );

    expect(await screen.findByText(en.quoteExpired)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.confirmAndStart })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.refreshQuote })).toBeInTheDocument();
  });

  it('explains a missing price in the customer’s words', async () => {
    render(
      <CheckPurchasePanel
        locale="en"
        onConfirm={vi.fn()}
        api={api('1000', {
          quote: vi.fn(async () => {
            throw new ApiError('PRICE_NOT_AVAILABLE', 'no price', 409);
          }),
        })}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(en.errors.PRICE_NOT_AVAILABLE ?? '');
  });

  it('asks for the balance in the quote’s own currency', async () => {
    // §87: no conversion. Comparing a EUR price to a USD balance would be one.
    const client = api();
    render(<CheckPurchasePanel locale="en" onConfirm={vi.fn()} api={client} />);
    await screen.findByText('$3.00');
    expect(client.balance).toHaveBeenCalledWith('USD');
  });

  it('renders in Arabic', async () => {
    render(<CheckPurchasePanel locale="ar" onConfirm={vi.fn()} api={api()} />);
    expect(await screen.findByText(ar.price)).toBeInTheDocument();
    expect(screen.getByText(ar.chargedOnDelivery)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ar.confirmAndStart })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The billing summary
// ---------------------------------------------------------------------------

describe('what a check cost', () => {
  it('says reserved, not charged, while the check is running', async () => {
    // §58.
    render(<CheckBillingSummary check={check()} locale="en" />);
    expect(screen.getByText(en.statuses.RESERVED ?? '')).toBeInTheDocument();
    expect(screen.queryByText(en.statuses.DELIVERED ?? '')).not.toBeInTheDocument();
  });

  it('says charged once the report is delivered, and links to the balance', () => {
    // §59.
    render(
      <CheckBillingSummary
        check={check({
          billing: billing({
            status: 'DELIVERED',
            reserved: { currency: 'USD', minorUnits: '0' },
            charged: { currency: 'USD', minorUnits: '300' },
            deliveredAt: '2026-09-14T09:05:00.000Z',
          }),
        })}
        locale="en"
      />,
    );

    expect(screen.getByText(en.statuses.DELIVERED ?? '')).toBeInTheDocument();
    expect(screen.getByText('$3.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.viewBalance })).toHaveAttribute(
      'href',
      '/en/balance',
    );
  });

  it('calls a released reservation a release, never a refund', () => {
    // §60, the wording rule this phase turns on.
    render(
      <CheckBillingSummary
        check={check({
          billing: billing({
            status: 'RELEASED',
            reserved: { currency: 'USD', minorUnits: '0' },
            failureCode: 'SERVICE_FAILED',
            releasedAt: '2026-09-14T09:05:00.000Z',
          }),
        })}
        locale="en"
      />,
    );

    expect(screen.getByText(en.statuses.RELEASED ?? '')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.noChargeMade))).toBeInTheDocument();
    expect(screen.getByText(en.failureCodes.SERVICE_FAILED ?? '')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/refund/i);
  });

  it('says a cancellation cost nothing, in the same words', () => {
    // §61.
    render(
      <CheckBillingSummary
        check={check({
          billing: billing({ status: 'RELEASED', failureCode: 'CANCELLED_BY_CUSTOMER' }),
        })}
        locale="en"
      />,
    );
    expect(screen.getByText(new RegExp(en.reservationReturned))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/refund/i);
  });

  it('draws the Arabic distinction between a release and a refund', () => {
    // §133: أُلغي الحجز for a release, and استرداد nowhere near it.
    const { rerender } = render(
      <CheckBillingSummary
        check={check({ billing: billing({ status: 'RELEASED' }) })}
        locale="ar"
      />,
    );
    expect(screen.getByText('أُلغي الحجز')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/استرداد/);

    rerender(
      <CheckBillingSummary
        check={check({
          billing: billing({
            status: 'REFUNDED',
            charged: { currency: 'USD', minorUnits: '300' },
            refundedAt: '2026-09-14T10:00:00.000Z',
          }),
        })}
        locale="ar"
      />,
    );
    expect(screen.getByText('أُعيد المبلغ')).toBeInTheDocument();
  });

  it('says a historical free check cost nothing, without inventing a purchase', () => {
    // §4, §89, §63.
    render(<CheckBillingSummary check={check({ billing: null, legacyFree: true })} locale="en" />);
    expect(screen.getByText(en.legacyFree)).toBeInTheDocument();
    expect(document.body.querySelector('[data-billing="LEGACY_FREE"]')).not.toBeNull();
  });

  it('carries the exact minor units beside the formatted amount', () => {
    const { container } = render(<CheckBillingSummary check={check()} locale="en" />);
    expect(container.querySelector('[data-minor-units="300"]')).not.toBeNull();
  });

  it('gives every state words, not only a colour', () => {
    // §62, §116 of Phase 10.
    for (const status of ['RESERVED', 'PROCESSING', 'DELIVERED', 'RELEASED', 'REFUNDED']) {
      const { unmount } = render(
        <CheckBillingSummary check={check({ billing: billing({ status }) })} locale="en" />,
      );
      expect(screen.getByText(en.statuses[status] ?? '')).toBeInTheDocument();
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

describe('cancelling a check', () => {
  it('offers cancellation while the check is still running', () => {
    render(<CancelCheckButton checkId="check-1" status="EVALUATING" locale="en" api={api()} />);
    expect(screen.getByRole('button', { name: en.cancelCheck })).toBeInTheDocument();
    expect(screen.getByText(en.cancelHint)).toBeInTheDocument();
  });

  it('offers nothing once the report exists', () => {
    // §43: the service was delivered, and a button promising otherwise would
    // be a lie the server would refuse.
    render(<CancelCheckButton checkId="check-1" status="COMPLETED" locale="en" api={api()} />);
    expect(screen.queryByRole('button', { name: en.cancelCheck })).not.toBeInTheDocument();
  });

  it('hands the cancelled check back to the page', async () => {
    const cancelled = check({
      status: 'CANCELLED',
      billing: billing({ status: 'RELEASED', failureCode: 'CANCELLED_BY_CUSTOMER' }),
    }) as CheckResponse;
    const onCancelled = vi.fn();
    const client = api('1000', { cancel: vi.fn(async () => cancelled) });

    render(
      <CancelCheckButton
        checkId="check-1"
        status="EVALUATING"
        locale="en"
        onCancelled={onCancelled}
        api={client}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.cancelCheck }));

    await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(cancelled));
    expect(client.cancel).toHaveBeenCalledWith('check-1');
  });

  it('explains a refused cancellation in the customer’s words', async () => {
    render(
      <CancelCheckButton
        checkId="check-1"
        status="GENERATING_REPORT"
        locale="en"
        api={api('1000', {
          cancel: vi.fn(async () => {
            throw new ApiError('SERVICE_ALREADY_DELIVERED', 'delivered', 409);
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.cancelCheck }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      en.errors.SERVICE_ALREADY_DELIVERED ?? '',
    );
  });
});
