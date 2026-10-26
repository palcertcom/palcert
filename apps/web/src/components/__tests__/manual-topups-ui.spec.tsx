import type {
  ManualPaymentMethodView,
  ManualTopUpRequestView,
} from '@palcert/contracts/finance/manual-topups';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BalanceHero } from '../balance-panels';
import { DestinationDetails, TopUpStatusBadge, describeTopUpError } from '../manual-topup';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { ApiError } from '@/lib/api-client';

const nav = vi.hoisted(() => ({
  params: { locale: 'en' } as Record<string, string>,
  search: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/en/balance/add',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({
  methods: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  submit: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
  createReceipt: vi.fn(),
  finalizeReceipt: vi.fn(),
  receipt: vi.fn(),
}));

vi.mock('@/lib/manual-topups-api', () => ({ manualTopUpsApi: api }));

const en = getManualTopUpMessages('en');
const ar = getManualTopUpMessages('ar');
const ILS = (minorUnits: string) => ({ currency: 'ILS', minorUnits });

function method(overrides: Partial<ManualPaymentMethodView> = {}): ManualPaymentMethodView {
  return {
    id: 'method-1',
    code: 'JAWWAL_PAY',
    type: 'MOBILE_WALLET',
    nameEn: 'Jawwal Pay',
    nameAr: 'جوال باي',
    descriptionEn: null,
    descriptionAr: null,
    currency: 'ILS',
    recipientName: 'PalCert Ltd',
    mobileNumber: '+970599000000',
    iban: null,
    bankName: null,
    accountNumber: null,
    branchName: null,
    instructionsEn: 'Use your email as the note.',
    instructionsAr: 'استخدم بريدك كملاحظة.',
    minAmount: ILS('1000'),
    maxAmount: ILS('500000'),
    logoUrl: null,
    ...overrides,
  };
}

function request(overrides: Partial<ManualTopUpRequestView> = {}): ManualTopUpRequestView {
  const m = method();
  return {
    id: 'request-1',
    status: 'DRAFT',
    amount: ILS('0'),
    reference: null,
    customerNote: null,
    paymentMethod: {
      snapshotVersion: 1,
      methodId: m.id,
      methodVersion: 2,
      code: m.code,
      type: m.type,
      nameEn: m.nameEn,
      nameAr: m.nameAr,
      currency: m.currency,
      recipientName: m.recipientName,
      mobileNumber: m.mobileNumber,
      iban: null,
      bankName: null,
      accountNumber: null,
      branchName: null,
      instructionsEn: m.instructionsEn,
      instructionsAr: m.instructionsAr,
      minAmountMinor: '1000',
      maxAmountMinor: '500000',
      capturedAt: '2026-10-02T12:00:00.000Z',
    },
    receipt: null,
    rejectionReason: null,
    rejectionNote: null,
    cancellable: true,
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:00:00.000Z',
    submittedAt: null,
    reviewStartedAt: null,
    decidedAt: null,
    cancelledAt: null,
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = { locale: 'en' };
  nav.search = new URLSearchParams();
});

describe('balance hero', () => {
  it('leads with what can be spent, explains it, and offers a way to add more', () => {
    render(
      <BalanceHero
        summary={{
          currency: 'ILS',
          available: ILS('15000'),
          reserved: ILS('500'),
          cash: ILS('14000'),
          promotional: ILS('1500'),
          accounts: [],
        }}
        locale="en"
        addHref="/en/balance/add"
        addLabel={en.hero.addBalance}
        addHint={en.hero.addBalanceHint}
      />,
    );
    expect(document.querySelector('[data-minor-units="15000"]')).not.toBeNull();
    for (const minor of ['14000', '1500', '500']) {
      expect(document.querySelector(`[data-minor-units="${minor}"]`)).not.toBeNull();
    }
    expect(screen.getByRole('link', { name: en.hero.addBalance }).getAttribute('href')).toBe(
      '/en/balance/add',
    );
    // A definition list holds only dt/dd groups (axe `definition-list`): the
    // hints are descriptions too, not stray paragraphs.
    for (const group of document.querySelectorAll('dl.pc-balance-hero-figures > div')) {
      for (const child of group.children) expect(['DT', 'DD']).toContain(child.tagName);
    }
  });
});

describe('destination details', () => {
  it('shows every field a person must retype, left to right, with a copy button', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DestinationDetails destination={method()} locale="ar" />);
    const number = screen.getByText('+970599000000');
    expect(number.getAttribute('dir')).toBe('ltr');
    fireEvent.click(
      screen.getByRole('button', { name: ar.destination.copyLabel(ar.destination.mobileNumber) }),
    );
    expect(writeText).toHaveBeenCalledWith('+970599000000');
    expect(screen.getByText('استخدم بريدك كملاحظة.')).toBeTruthy();
  });

  it('can show a frozen snapshot without copy buttons', () => {
    render(<DestinationDetails destination={method()} locale="en" copyable={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('status and errors', () => {
  it('names every status in words, never by colour alone', () => {
    render(<TopUpStatusBadge status="PENDING_REVIEW" locale="en" />);
    expect(screen.getByText(en.statuses['PENDING_REVIEW']!)).toBeTruthy();
  });

  it('never tells a finance reviewer the money was added to "your balance"', () => {
    render(<TopUpStatusBadge status="APPROVED" locale="en" audience="staff" />);
    expect(screen.getByText(en.staffStatuses['APPROVED']!)).toBeTruthy();
    expect(screen.queryByText(en.statuses['APPROVED']!)).toBeNull();
  });

  it('turns a duplicate reference into the one generic sentence, and spots a re-sign-in', () => {
    expect(
      describeTopUpError(en, new ApiError('MANUAL_TOPUP_REFERENCE_UNAVAILABLE', 'x', 409)).message,
    ).toBe(en.errors['MANUAL_TOPUP_REFERENCE_UNAVAILABLE']);
    expect(describeTopUpError(en, new ApiError('REAUTHENTICATION_REQUIRED', 'x', 401)).reauth).toBe(
      true,
    );
    expect(describeTopUpError(en, new Error('boom')).message).toBe(en.genericError);
  });
});

describe('the add-balance wizard', () => {
  it('walks method → send → details → review, and only then submits', async () => {
    const { default: AddBalancePage } = await import('@/app/[locale]/balance/add/page');
    api.methods.mockResolvedValue([method()]);
    api.create.mockResolvedValue(request());
    api.update.mockResolvedValue(
      request({ amount: ILS('15000'), reference: 'TX-1', customerNote: null }),
    );
    api.submit.mockResolvedValue(request({ status: 'PENDING_REVIEW' }));

    render(<AddBalancePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Jawwal Pay/ }));
    expect(screen.getByText('+970599000000')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.wizard.sent }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith('method-1', {}, expect.any(String)),
    );

    fireEvent.change(await screen.findByLabelText(en.wizard.amount), {
      target: { value: '150.00' },
    });
    fireEvent.change(screen.getByLabelText(en.wizard.reference), { target: { value: 'TX-1' } });
    fireEvent.click(screen.getByRole('button', { name: en.wizard.next }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith('request-1', {
        amountMinorUnits: '15000',
        reference: 'TX-1',
        customerNote: null,
      }),
    );

    // The review step says the balance does not change yet, and nothing has
    // been submitted until the person says so.
    expect(await screen.findByText(en.wizard.reviewNotice)).toBeTruthy();
    expect(api.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en.wizard.submit }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith('request-1'));
    expect(nav.push).toHaveBeenCalledWith('/en/balance/top-ups/request-1');
  });

  it('refuses an amount it cannot turn into exact units, before calling the API', async () => {
    const { default: AddBalancePage } = await import('@/app/[locale]/balance/add/page');
    api.methods.mockResolvedValue([method()]);
    api.get.mockResolvedValue(request());
    nav.search = new URLSearchParams('draft=request-1');

    render(<AddBalancePage />);
    fireEvent.change(await screen.findByLabelText(en.wizard.amount), {
      target: { value: '1.234' },
    });
    fireEvent.change(screen.getByLabelText(en.wizard.reference), { target: { value: 'TX-1' } });
    fireEvent.click(screen.getByRole('button', { name: en.wizard.next }));
    expect(await screen.findByText(en.wizard.amountInvalid)).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('says plainly when no transfer method is offered', async () => {
    const { default: AddBalancePage } = await import('@/app/[locale]/balance/add/page');
    api.methods.mockResolvedValue([]);
    render(<AddBalancePage />);
    expect(await screen.findByText(en.wizard.noMethods)).toBeTruthy();
  });
});
