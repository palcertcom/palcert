import type {
  AdminManualPaymentMethodView,
  AdminManualTopUpRequestView,
  ManualTopUpNotificationReportView,
} from '@palcert/contracts/finance/manual-topups';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PaymentMethodsPage from '@/app/[locale]/admin/payment-methods/page';
import AdminTopUpPage from '@/app/[locale]/admin/top-ups/[requestId]/page';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';

const nav = vi.hoisted(() => ({
  params: { locale: 'en', requestId: 'request-1' } as Record<string, string>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/${nav.params['locale']}/admin/payment-methods`,
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(),
}));

const shell = vi.hoisted(() => ({
  state: {
    status: 'signed-in' as const,
    user: { id: 'admin-1' },
    globalPermissions: new Set<string>() as ReadonlySet<string>,
  },
}));
vi.mock('@/components/shell/shell-context', () => ({ useShell: () => shell.state }));

const api = vi.hoisted(() => ({
  methods: { list: vi.fn(), reviewerCandidates: vi.fn(), create: vi.fn(), update: vi.fn() },
  review: { get: vi.fn(), notificationReport: vi.fn() },
}));
vi.mock('@/lib/manual-topups-api', () => ({
  paymentMethodsAdminApi: api.methods,
  manualTopUpsAdminApi: api.review,
  manualTopUpsApi: {},
}));

const en = getManualTopUpMessages('en');
const ar = getManualTopUpMessages('ar');
const ADMIN = [
  'admin:payment-method:read',
  'admin:payment-method:manage',
  'finance:manual-topup:read',
];
const ILS = (minorUnits: string) => ({ currency: 'ILS', minorUnits });

function method(
  overrides: Partial<AdminManualPaymentMethodView> = {},
): AdminManualPaymentMethodView {
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
    instructionsEn: null,
    instructionsAr: null,
    minAmount: ILS('1000'),
    maxAmount: ILS('500000'),
    logoUrl: null,
    enabled: false,
    displayOrder: 0,
    version: 1,
    archivedAt: null,
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    createdByUserId: null,
    updatedByUserId: null,
    logo: null,
    referenced: false,
    reviewers: [],
    ...overrides,
  };
}

const CANDIDATES = [
  {
    userId: 'finance-1',
    displayName: 'Raed Rasheed',
    email: 'rrasheed@example.com',
    emailVerified: true,
    roles: ['PALCERT_FINANCE'],
  },
  {
    userId: 'finance-2',
    displayName: 'Finance Officer',
    email: 'finance@example.com',
    emailVerified: false,
    roles: ['PALCERT_FINANCE'],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = { locale: 'en', requestId: 'request-1' };
  shell.state.globalPermissions = new Set(ADMIN);
  api.methods.reviewerCandidates.mockResolvedValue(CANDIDATES);
});

describe('payment method reviewers', () => {
  it('says plainly when nobody is assigned, and will not offer the method', async () => {
    api.methods.list.mockResolvedValue([method()]);
    render(<PaymentMethodsPage />);
    const card = await screen.findByTestId('method-reviewers');
    expect(card).toHaveTextContent(`${en.reviewers.label}: ${en.reviewers.none}`);
    expect(card).toHaveTextContent(en.reviewers.required);
    const enable = screen.getByRole('button', { name: en.admin.enable });
    expect(enable).toBeDisabled();
    expect(enable.getAttribute('aria-describedby')).toBe('reviewers-method-1');
  });

  it('names the reviewers on the card and flags one who lost the permission', async () => {
    api.methods.list.mockResolvedValue([
      method({
        enabled: true,
        reviewers: [
          {
            userId: 'finance-1',
            displayName: 'Raed Rasheed',
            email: 'rrasheed@example.com',
            emailVerified: true,
            eligible: true,
            assignedAt: '2026-10-03T10:00:00.000Z',
          },
          {
            userId: 'finance-3',
            displayName: 'Former Officer',
            email: 'former@example.com',
            emailVerified: true,
            eligible: false,
            assignedAt: '2026-10-03T10:00:00.000Z',
          },
        ],
      }),
    ]);
    render(<PaymentMethodsPage />);
    const card = await screen.findByTestId('method-reviewers');
    expect(card).toHaveTextContent('Raed Rasheed');
    expect(card).toHaveTextContent(`Former Officer (${en.reviewers.ineligible})`);
  });

  it('offers only the eligible staff, with email status, and sends user ids — never an address', async () => {
    api.methods.list.mockResolvedValue([]);
    api.methods.create.mockResolvedValue(method({ reviewers: [] }));
    render(<PaymentMethodsPage />);
    fireEvent.click(await screen.findByRole('button', { name: en.admin.newMethod }));

    const picker = await screen.findByTestId('reviewer-picker');
    expect(within(picker).getByText(en.reviewers.title)).toBeTruthy();
    await within(picker).findByText('Raed Rasheed');
    expect(picker).toHaveTextContent('rrasheed@example.com');
    expect(picker).toHaveTextContent(en.reviewers.emailVerified);
    expect(picker).toHaveTextContent(en.reviewers.emailNotVerified);
    expect(picker).toHaveTextContent(en.reviewers.required);
    // Checkboxes only: there is nowhere to type an address.
    expect(within(picker).queryByRole('textbox')).toBeNull();

    fireEvent.click(within(picker).getByRole('checkbox', { name: /Raed Rasheed/ }));
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Finance Officer/ }));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en.admin.code}`)), {
      target: { value: 'jawwal_pay' },
    });
    fireEvent.change(screen.getByLabelText(en.admin.nameEn), { target: { value: 'Jawwal Pay' } });
    fireEvent.change(screen.getByLabelText(en.admin.nameAr), { target: { value: 'جوال باي' } });
    fireEvent.click(screen.getByRole('button', { name: en.admin.save }));
    await waitFor(() => expect(api.methods.create).toHaveBeenCalled());
    expect(api.methods.create.mock.calls[0]?.[0]).toMatchObject({
      reviewerUserIds: ['finance-1', 'finance-2'],
    });
  });

  it('speaks Arabic', async () => {
    nav.params = { locale: 'ar', requestId: 'request-1' };
    api.methods.list.mockResolvedValue([method()]);
    render(<PaymentMethodsPage />);
    const card = await screen.findByTestId('method-reviewers');
    expect(card).toHaveTextContent('لم يتم تعيين مسؤولين للمراجعة');
    expect(card).toHaveTextContent(ar.reviewers.required);
    fireEvent.click(screen.getByRole('button', { name: ar.admin.editMethod }));
    const picker = await screen.findByTestId('reviewer-picker');
    expect(picker).toHaveTextContent('مسؤولو مراجعة عمليات الشحن');
    expect(picker).toHaveTextContent('تعيين مسؤول مراجعة');
    await within(picker).findByText('Raed Rasheed');
    expect(picker).toHaveTextContent('البريد الإلكتروني موثّق');
    expect(picker).toHaveTextContent('البريد الإلكتروني غير موثّق');
  });
});

describe('the delivery report', () => {
  function request(): AdminManualTopUpRequestView {
    return {
      id: 'request-1',
      status: 'PENDING_REVIEW',
      amount: ILS('2500'),
      reference: 'REF-1',
      customerNote: null,
      paymentMethod: {
        snapshotVersion: 1,
        methodId: 'method-1',
        methodVersion: 2,
        code: 'JAWWAL_PAY',
        type: 'MOBILE_WALLET',
        nameEn: 'Jawwal Pay',
        nameAr: 'جوال باي',
        currency: 'ILS',
        recipientName: 'PalCert Ltd',
        mobileNumber: '+970599000000',
        iban: null,
        bankName: null,
        accountNumber: null,
        branchName: null,
        instructionsEn: null,
        instructionsAr: null,
        minAmountMinor: '1000',
        maxAmountMinor: '500000',
        capturedAt: '2026-10-03T10:00:00.000Z',
      },
      receipt: null,
      rejectionReason: null,
      rejectionNote: null,
      createdAt: '2026-10-03T10:00:00.000Z',
      updatedAt: '2026-10-03T10:00:00.000Z',
      submittedAt: '2026-10-03T10:01:00.000Z',
      reviewStartedAt: null,
      decidedAt: null,
      cancelledAt: null,
      ownerUserId: 'person-1',
      ownerDisplayName: null,
      ownerEmail: 'person@example.test',
      referenceNormalized: 'REF1',
      reviewStartedByUserId: null,
      decidedByUserId: null,
      creditEntryId: null,
      events: [],
    } as unknown as AdminManualTopUpRequestView;
  }

  const REPORT: ManualTopUpNotificationReportView = {
    routing: 'METHOD_REVIEWERS',
    noReviewerAvailable: false,
    recipients: [
      {
        userId: 'finance-1',
        displayName: 'Raed Rasheed',
        emailMasked: 'r***@example.com',
        emailVerified: true,
        accountStatus: 'ACTIVE',
        assigned: true,
        notifiedAt: '2026-10-03T10:01:05.000Z',
        readAt: null,
        inAppStatus: 'DELIVERED',
        emailStatus: 'SKIPPED',
        emailSkipReason: 'CHANNEL_DISABLED',
        emailAttempts: 0,
        emailErrorCode: null,
        emailUpdatedAt: '2026-10-03T10:01:06.000Z',
      },
    ],
    assignedReviewers: [
      {
        userId: 'finance-1',
        displayName: 'Raed Rasheed',
        emailMasked: 'r***@example.com',
        emailVerified: true,
        eligible: true,
        assignedAt: '2026-10-03T10:00:00.000Z',
        notified: true,
      },
      {
        userId: 'finance-3',
        displayName: 'Former Officer',
        emailMasked: 'f***@example.com',
        emailVerified: true,
        eligible: false,
        assignedAt: '2026-10-03T10:00:00.000Z',
        notified: false,
      },
    ],
  };

  it('shows each recipient, the email status and the safe skip reason', async () => {
    api.review.get.mockResolvedValue(request());
    api.review.notificationReport.mockResolvedValue(REPORT);
    render(<AdminTopUpPage />);
    const panel = await screen.findByTestId('notification-report');
    await within(panel).findByText('Raed Rasheed');
    expect(panel).toHaveTextContent(en.delivery.routing['METHOD_REVIEWERS']!);
    expect(panel).toHaveTextContent('r***@example.com');
    expect(panel).toHaveTextContent(`${en.delivery.emailStatuses['SKIPPED']} (SKIPPED)`);
    expect(panel).toHaveTextContent(
      `${en.delivery.skipReasons['CHANNEL_DISABLED']} (CHANNEL_DISABLED)`,
    );
    expect(panel).toHaveTextContent(en.delivery.notNotifiedTitle);
    expect(panel).toHaveTextContent('Former Officer');
    expect(panel).not.toHaveTextContent('rrasheed@example.com');
  });

  it('is not shown to finance staff who cannot manage payment methods', async () => {
    shell.state.globalPermissions = new Set([
      'finance:manual-topup:read',
      'finance:manual-topup:review',
      'admin:payment-method:read',
    ]);
    api.review.get.mockResolvedValue(request());
    render(<AdminTopUpPage />);
    await screen.findByText(en.admin.requestTitle, { selector: 'h1' });
    expect(screen.queryByTestId('notification-report')).toBeNull();
    expect(api.review.notificationReport).not.toHaveBeenCalled();
  });

  it('every status and reason has English and Arabic words', () => {
    for (const status of [
      'PENDING',
      'SENDING',
      'DELIVERED',
      'SKIPPED',
      'FAILED_RETRYABLE',
      'FAILED_PERMANENT',
    ]) {
      expect(en.delivery.emailStatuses[status]).toBeTruthy();
      expect(ar.delivery.emailStatuses[status]).toBeTruthy();
    }
    for (const reason of [
      'NO_VERIFIED_EMAIL',
      'PREFERENCE_DISABLED',
      'AUTHORIZATION_REVOKED',
      'CHANNEL_DISABLED',
      'ACCOUNT_INELIGIBLE',
    ]) {
      expect(en.delivery.skipReasons[reason]).toBeTruthy();
      expect(ar.delivery.skipReasons[reason]).toBeTruthy();
    }
    expect(ar.errors['MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED']).toBe(ar.reviewers.required);
  });
});
