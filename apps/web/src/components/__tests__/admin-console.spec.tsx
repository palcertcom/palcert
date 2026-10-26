import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsForRoles } from '@/lib/organization-permissions';
import AdminOverviewPage from '@/app/[locale]/admin/page';
import AdminOrganizationsPage from '@/app/[locale]/admin/organizations/page';
import AdminOrganizationPage from '@/app/[locale]/admin/organizations/[organizationId]/page';
import AdminUsersPage from '@/app/[locale]/admin/users/page';
import AdminUserPage from '@/app/[locale]/admin/users/[userId]/page';
import AdminFinancePage from '@/app/[locale]/admin/finance/page';
import CustomerFinancePage from '@/app/[locale]/admin/finance/customers/[userId]/page';
import { ADMIN_MESSAGES } from '@/i18n/admin-messages';
import { breadcrumbsFor } from '@/lib/breadcrumbs';
import { safeReturnPath } from '@/lib/return-path';
import { adminNavigation } from '@/lib/shell-navigation';
import type * as ApiClient from '@/lib/api-client';
import type {
  AdminOrganizationDetailResponse,
  AdminUserSummaryResponse,
  UserProfileResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const nav = vi.hoisted(() => ({
  params: { locale: 'en' } as Record<string, string>,
  search: new URLSearchParams(),
  pathname: '/en/admin',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
}));

const shell = vi.hoisted(() => ({
  state: {
    status: 'signed-in' as 'signed-in' | 'loading' | 'signed-out',
    user: { id: 'staff-1' } as { id: string } | null,
    globalPermissions: new Set<string>() as ReadonlySet<string>,
  },
}));
vi.mock('@/components/shell/shell-context', () => ({ useShell: () => shell.state }));

const admin = vi.hoisted(() => ({
  overview: vi.fn(),
  organizations: vi.fn(),
  verificationQueue: vi.fn(),
  organization: vi.fn(),
  decideVerification: vi.fn(),
  suspendOrganization: vi.fn(),
  reactivateOrganization: vi.fn(),
  users: vi.fn(),
  user: vi.fn(),
  suspendUser: vi.fn(),
  reactivateUser: vi.fn(),
  grantRole: vi.fn(),
  removeRole: vi.fn(),
}));
const finance = vi.hoisted(() => ({
  prices: vi.fn(),
  createPrice: vi.fn(),
  activatePrice: vi.fn(),
  retirePrice: vi.fn(),
  balance: vi.fn(),
  payments: vi.fn(),
  purchases: vi.fn(),
  adjust: vi.fn(),
  refund: vi.fn(),
  refundById: vi.fn(),
  verifyLedger: vi.fn(),
  purchaseSummary: vi.fn(),
  purchaseReport: vi.fn(),
}));
const currencies = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return {
    ...actual,
    adminApi: admin,
    financeAdminApi: finance,
    balanceApi: { ...actual.balanceApi, currencies },
  };
});

const { ApiError, ADMIN_USER_PAGE_SIZE } =
  await vi.importActual<ApiClientModule>('@/lib/api-client');
const en = ADMIN_MESSAGES.en;

/** What `/users/me` reports for each staff role, from the real role catalogue. */
const ROLE = (role: string) => permissionsForRoles([role]);

function staff(role: string): void {
  shell.state = { status: 'signed-in', user: { id: 'staff-1' }, globalPermissions: ROLE(role) };
}

const ORG_DETAIL: AdminOrganizationDetailResponse = {
  organization: {
    id: 'org-1',
    slug: 'iug',
    displayName: 'Islamic University of Gaza',
    legalName: 'Islamic University of Gaza',
    type: 'UNIVERSITY',
    status: 'ACTIVE',
    verificationStatus: 'PENDING',
    countryCode: 'PS',
    website: 'https://iugaza.edu.ps',
    defaultLocale: 'ar',
    timezone: 'Asia/Gaza',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    memberCount: 7,
  },
  suspendedAt: null,
  suspensionReason: null,
  verificationRequests: [
    {
      id: 'req-1',
      status: 'PENDING',
      requestedAt: '2026-02-01T00:00:00.000Z',
      submissionNote: 'Ministry registration 1234.',
      reviewedAt: null,
      decisionReason: null,
    },
  ],
};

const USER: UserProfileResponse = {
  id: 'user-9',
  email: 'layla@example.com',
  displayName: 'Layla Haddad',
  status: 'ACTIVE',
  preferredLocale: 'ar',
  emailVerified: true,
  mfaEnrolled: false,
  mfaRequired: false,
  roles: ['STUDENT'],
  permissions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = { locale: 'en' };
  nav.search = new URLSearchParams();
  nav.pathname = '/en/admin';
  staff('PALCERT_ADMIN');
  currencies.mockResolvedValue(['USD', 'JOD']);
  finance.purchaseSummary.mockResolvedValue({ from: null, to: null, rows: [] });
  finance.purchaseReport.mockResolvedValue([]);
});

describe('staff navigation', () => {
  const hrefs = (role: string) => adminNavigation('en', ROLE(role)).map((item) => item.href);

  it('offers nothing to an ordinary account or an organization owner', () => {
    expect(hrefs('STUDENT')).toEqual([]);
    expect(hrefs('SERVICE_USER')).toEqual([]);
    expect(adminNavigation('en', permissionsForRoles(['ORGANIZATION_OWNER']))).toEqual([]);
  });

  it('offers each staff role the areas it can read', () => {
    const all = ['/en/admin', '/en/admin/organizations', '/en/admin/users', '/en/admin/finance'];
    // Manual top-ups: the queue for every role that reads it, and the payment
    // methods for every role that reads those. Support reads neither.
    const withTopUps = [...all, '/en/admin/top-ups', '/en/admin/payment-methods'];
    // Withdrawals (ADR-0150): the queue, platform funds and settings for every
    // role that reads withdrawals — administrators, finance and auditors.
    const withdrawals = [
      '/en/admin/withdrawals',
      '/en/admin/platform-funds',
      '/en/admin/withdrawal-settings',
    ];
    const withPayouts = [...all, '/en/admin/top-ups', ...withdrawals, '/en/admin/payment-methods'];
    // Attestation finance is for the roles that read PalCert's revenue; support does not.
    const withAttestations = [...withPayouts, '/en/admin/attestations'];
    void withTopUps;
    // Email settings and delivery history: administrators and auditors (read-only).
    const withEmail = [
      ...withAttestations,
      '/en/admin/email-settings',
      '/en/admin/email-deliveries',
    ];
    expect(hrefs('PALCERT_ADMIN')).toEqual(withEmail);
    expect(hrefs('PALCERT_FINANCE')).toEqual(withAttestations);
    expect(hrefs('PALCERT_SUPPORT')).toEqual(all);
    expect(hrefs('PALCERT_AUDITOR')).toEqual(withEmail);
  });

  it('names the trail inside the console', () => {
    expect(breadcrumbsFor('/en/admin/organizations/org-1', 'en').map((c) => c.label)).toEqual([
      en.nav.overview,
      en.nav.organizations,
      expect.any(String),
    ]);
    expect(breadcrumbsFor('/en/admin/finance/customers/u-1', 'en').at(-1)?.label).toBe(
      en.customer.title,
    );
  });
});

describe('the gate', () => {
  it('shows a refusal and asks the API nothing for someone who is not staff', async () => {
    staff('STUDENT');
    render(<AdminOverviewPage />);
    expect(await screen.findByRole('heading', { name: en.forbiddenTitle })).toBeTruthy();
    expect(admin.overview).not.toHaveBeenCalled();
  });

  it('waits for the session before deciding', () => {
    shell.state = { status: 'loading', user: null, globalPermissions: new Set() };
    render(<AdminUsersPage />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(admin.users).not.toHaveBeenCalled();
  });
});

describe('overview', () => {
  it('shows exactly the counts the API returned', async () => {
    admin.overview.mockResolvedValue({
      generatedAt: '2026-09-25T10:00:00.000Z',
      organizations: {
        total: 12,
        byStatus: { ACTIVE: 11, SUSPENDED: 1 },
        byVerificationStatus: { VERIFIED: 8, PENDING: 2, UNVERIFIED: 2 },
        pendingVerificationRequests: 2,
      },
      users: { total: 340, byStatus: { ACTIVE: 330, SUSPENDED: 4, PENDING_VERIFICATION: 6 } },
    });
    render(<AdminOverviewPage />);
    expect(await screen.findByText('12')).toBeTruthy();
    expect(screen.getByText('340')).toBeTruthy();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  it('reports a failure instead of zeros', async () => {
    admin.overview.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'no', 403));
    render(<AdminOverviewPage />);
    expect((await screen.findByRole('alert')).textContent).toContain(en.errors.PERMISSION_DENIED);
  });
});

describe('organizations', () => {
  it('lists organizations without an invented member count', async () => {
    admin.organizations.mockResolvedValue({
      items: [{ ...ORG_DETAIL.organization, memberCount: 0 }],
      nextCursor: null,
    });
    render(<AdminOrganizationsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Islamic University of Gaza' })).toHaveAttribute(
      'href',
      '/en/admin/organizations/org-1',
    );
    expect(within(table).queryByText('0')).toBeNull();
  });

  it('opens the verification queue only for staff who may decide', async () => {
    admin.organizations.mockResolvedValue({ items: [], nextCursor: null });
    admin.verificationQueue.mockResolvedValue([]);
    nav.search = new URLSearchParams('view=queue');
    render(<AdminOrganizationsPage />);
    expect(await screen.findByText(en.organizations.queueEmpty)).toBeTruthy();

    staff('PALCERT_SUPPORT');
    admin.organizations.mockResolvedValue({ items: [], nextCursor: null });
    const { container } = render(<AdminOrganizationsPage />);
    await waitFor(() => expect(admin.organizations).toHaveBeenCalled());
    expect(within(container).queryByRole('button', { name: en.organizations.tabQueue })).toBeNull();
  });

  it('approves with the reason given, and reads the organization again', async () => {
    nav.params = { locale: 'en', organizationId: 'org-1' };
    admin.organization.mockResolvedValueOnce(ORG_DETAIL).mockResolvedValueOnce({
      ...ORG_DETAIL,
      organization: { ...ORG_DETAIL.organization, verificationStatus: 'VERIFIED' },
    });
    admin.decideVerification.mockResolvedValue({ status: 'VERIFIED' });
    render(<AdminOrganizationPage />);

    fireEvent.click(await screen.findByRole('button', { name: en.organization.approve }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(
      within(dialog).getByLabelText(new RegExp(en.organization.decisionReasonLabel)),
      {
        target: { value: '  Confirmed with the ministry.  ' },
      },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: en.organization.approve }));

    await waitFor(() =>
      expect(admin.decideVerification).toHaveBeenCalledWith('org-1', {
        approve: true,
        decisionReason: 'Confirmed with the ministry.',
      }),
    );
    expect(await screen.findByText(en.organization.approved)).toBeTruthy();
    expect(admin.organization).toHaveBeenCalledTimes(2);
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('will not reject without a reason for the organization', async () => {
    nav.params = { locale: 'en', organizationId: 'org-1' };
    admin.organization.mockResolvedValue(ORG_DETAIL);
    render(<AdminOrganizationPage />);
    fireEvent.click(await screen.findByRole('button', { name: en.organization.reject }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.organization.reject }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(admin.decideVerification).not.toHaveBeenCalled();
  });

  it('asks for a fresh sign-in when the API requires one, and comes back here', async () => {
    nav.params = { locale: 'en', organizationId: 'org-1' };
    nav.pathname = '/en/admin/organizations/org-1';
    admin.organization.mockResolvedValue(ORG_DETAIL);
    admin.suspendOrganization.mockRejectedValue(
      new ApiError('REAUTHENTICATION_REQUIRED', 'again', 401),
    );
    render(<AdminOrganizationPage />);
    fireEvent.click(await screen.findByRole('button', { name: en.organization.suspend }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.organization.suspend }));
    const again = await within(dialog).findByRole('link', { name: en.reauthAction });
    expect(again.getAttribute('href')).toBe(
      `/en/login?next=${encodeURIComponent('/en/admin/organizations/org-1')}`,
    );
  });

  it('offers no decisions or suspension to support', async () => {
    staff('PALCERT_SUPPORT');
    nav.params = { locale: 'en', organizationId: 'org-1' };
    admin.organization.mockResolvedValue(ORG_DETAIL);
    render(<AdminOrganizationPage />);
    expect(await screen.findByText(en.organization.pendingRequest)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.organization.approve })).toBeNull();
    expect(screen.queryByRole('button', { name: en.organization.suspend })).toBeNull();
  });
});

describe('users', () => {
  const row = (index: number): AdminUserSummaryResponse => ({
    id: `u-${index}`,
    email: `person${index}@example.com`,
    displayName: null,
    status: 'ACTIVE',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  });

  it('searches through the API and pages by the last account seen', async () => {
    admin.users
      .mockResolvedValueOnce(Array.from({ length: ADMIN_USER_PAGE_SIZE }, (_, i) => row(i)))
      .mockResolvedValueOnce([row(99)])
      .mockResolvedValueOnce([]);
    render(<AdminUsersPage />);

    fireEvent.click(await screen.findByRole('button', { name: en.common.loadMore }));
    await waitFor(() =>
      expect(admin.users).toHaveBeenLastCalledWith({ cursor: `u-${ADMIN_USER_PAGE_SIZE - 1}` }),
    );

    fireEvent.change(screen.getByLabelText(en.users.searchLabel), { target: { value: ' layla ' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.search }));
    await waitFor(() => expect(admin.users).toHaveBeenLastCalledWith({ q: 'layla' }));
    expect(await screen.findByText(en.users.noMatches)).toBeTruthy();
  });

  it('grants a role after confirmation and shows the account as returned', async () => {
    nav.params = { locale: 'en', userId: 'user-9' };
    admin.user.mockResolvedValue(USER);
    admin.grantRole.mockResolvedValue({ ...USER, roles: ['STUDENT', 'PALCERT_SUPPORT'] });
    render(<AdminUserPage />);

    const select = await screen.findByLabelText(en.user.roleLabel);
    fireEvent.change(select, { target: { value: 'PALCERT_SUPPORT' } });
    expect(screen.getByText(en.user.privilegedWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.user.grantRole }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: en.user.grantRole }),
    );
    await waitFor(() => expect(admin.grantRole).toHaveBeenCalledWith('user-9', 'PALCERT_SUPPORT'));
    expect(await screen.findByText(en.user.granted)).toBeTruthy();
  });

  it('never offers the machine role or organization roles', async () => {
    nav.params = { locale: 'en', userId: 'user-9' };
    admin.user.mockResolvedValue(USER);
    render(<AdminUserPage />);
    const options = Array.from(
      (await screen.findByLabelText(en.user.roleLabel)).querySelectorAll('option'),
    ).map((option) => option.getAttribute('value'));
    expect(options).not.toContain('API_CLIENT');
    expect(options).not.toContain('ORGANIZATION_OWNER');
    expect(options).toContain('PALCERT_ADMIN');
  });

  it('offers no status or role change on your own account', async () => {
    nav.params = { locale: 'en', userId: 'staff-1' };
    admin.user.mockResolvedValue({ ...USER, id: 'staff-1', roles: ['PALCERT_ADMIN'] });
    render(<AdminUserPage />);
    expect(await screen.findByText(en.user.yourself)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.user.suspend })).toBeNull();
    expect(screen.queryByRole('button', { name: en.user.removeRole })).toBeNull();
  });

  it('lets support read an account and change nothing', async () => {
    staff('PALCERT_SUPPORT');
    nav.params = { locale: 'en', userId: 'user-9' };
    admin.user.mockResolvedValue(USER);
    render(<AdminUserPage />);
    await screen.findByText('layla@example.com');
    expect(screen.queryByRole('button', { name: en.user.suspend })).toBeNull();
    expect(screen.queryByLabelText(en.user.roleLabel)).toBeNull();
  });
});

describe('finance', () => {
  it('puts a draft price into force after confirmation', async () => {
    staff('PALCERT_FINANCE');
    finance.prices.mockResolvedValue([
      {
        id: 'p-1',
        productCode: 'DOCUMENT_CHECK',
        marketCode: 'DEFAULT',
        amount: { currency: 'USD', minorUnits: '1250' },
        status: 'DRAFT',
        effectiveFrom: null,
        effectiveUntil: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        activatedAt: null,
      },
    ]);
    finance.activatePrice.mockResolvedValue({});
    render(<AdminFinancePage />);
    fireEvent.click(await screen.findByRole('button', { name: en.finance.activate }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: en.finance.activate }),
    );
    await waitFor(() => expect(finance.activatePrice).toHaveBeenCalledWith('p-1'));
    expect(await screen.findByText(en.finance.activated)).toBeTruthy();
  });

  it('drafts a price in exact minor units, refusing extra decimals', async () => {
    staff('PALCERT_FINANCE');
    finance.prices.mockResolvedValue([]);
    finance.createPrice.mockResolvedValue({});
    render(<AdminFinancePage />);
    await screen.findByText(en.finance.noPrices);
    await waitFor(() => expect(currencies).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(en.finance.amount), { target: { value: '12.505' } });
    fireEvent.click(screen.getByRole('button', { name: en.finance.createDraft }));
    expect(await screen.findByText(en.finance.invalidAmount)).toBeTruthy();
    expect(finance.createPrice).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(en.finance.amount), { target: { value: '12.50' } });
    fireEvent.click(screen.getByRole('button', { name: en.finance.createDraft }));
    await waitFor(() =>
      expect(finance.createPrice).toHaveBeenCalledWith({
        productCode: 'DOCUMENT_CHECK',
        currency: 'USD',
        amountMinorUnits: '1250',
      }),
    );
  });

  it('runs the ledger check on request and shows its findings', async () => {
    staff('PALCERT_AUDITOR');
    finance.prices.mockResolvedValue([]);
    finance.verifyLedger.mockResolvedValue({
      checkedAt: '2026-09-25T10:00:00.000Z',
      accountsChecked: 4,
      entriesChecked: 20,
      findings: [
        { code: 'BALANCE_MISMATCH', detail: 'replayed 10, stored 12', subjectId: 'acc-1' },
      ],
      consistent: false,
    });
    render(<AdminFinancePage />);
    expect(finance.verifyLedger).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: en.finance.runCheck }));
    expect(await screen.findByText(en.finance.inconsistent)).toBeTruthy();
    expect(screen.getByText('BALANCE_MISMATCH')).toBeTruthy();
    // An auditor reads; it does not price.
    expect(screen.queryByRole('button', { name: en.finance.createDraft })).toBeNull();
  });

  it('groups AI services apart when drafting a price, and tags them in the list', async () => {
    staff('PALCERT_FINANCE');
    finance.prices.mockResolvedValue([
      {
        id: 'p-ai',
        productCode: 'AI_REVIEW',
        marketCode: 'GLOBAL',
        amount: { currency: 'USD', minorUnits: '50' },
        status: 'ACTIVE',
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        effectiveUntil: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        activatedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    finance.createPrice.mockResolvedValue({});
    render(<AdminFinancePage />);
    expect((await screen.findAllByText(en.products.AI_REVIEW ?? '')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.finance.aiTag).length).toBeGreaterThan(0);
    const groups = Array.from(document.querySelectorAll('optgroup')).map((group) => group.label);
    expect(groups).toContain(en.finance.aiServices);
    await waitFor(() => expect(currencies).toHaveBeenCalled());

    const product = screen.getAllByLabelText(en.finance.product)[0] as HTMLSelectElement;
    fireEvent.change(product, { target: { value: 'AI_RULE_EXTRACTION' } });
    fireEvent.change(screen.getByLabelText(en.finance.amount), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: en.finance.createDraft }));
    await waitFor(() =>
      expect(finance.createPrice).toHaveBeenCalledWith({
        productCode: 'AI_RULE_EXTRACTION',
        currency: 'USD',
        amountMinorUnits: '200',
      }),
    );
  });

  it('reports purchases per product and currency, never summing currencies', async () => {
    staff('PALCERT_FINANCE');
    finance.prices.mockResolvedValue([]);
    const money = (currency: string, minorUnits: string) => ({ currency, minorUnits });
    finance.purchaseSummary.mockResolvedValue({
      from: null,
      to: null,
      rows: [
        {
          productCode: 'AI_REVIEW',
          currency: 'USD',
          purchaseCount: 3,
          reservedCount: 1,
          reservedAmount: money('USD', '50'),
          capturedCount: 1,
          capturedAmount: money('USD', '50'),
          releasedCount: 1,
          refundedCount: 0,
          refundedAmount: money('USD', '0'),
          reconciliationCount: 0,
        },
        {
          productCode: 'AI_REVIEW',
          currency: 'JOD',
          purchaseCount: 1,
          reservedCount: 0,
          reservedAmount: money('JOD', '0'),
          capturedCount: 1,
          capturedAmount: money('JOD', '350'),
          releasedCount: 0,
          refundedCount: 0,
          refundedAmount: money('JOD', '0'),
          reconciliationCount: 0,
        },
      ],
    });
    finance.purchaseReport.mockResolvedValue([
      {
        purchaseId: 'pu-1',
        productCode: 'AI_RULE_EXTRACTION',
        resourceType: 'AI_RULE_EXTRACTION',
        resourceId: 'run-1',
        status: 'DELIVERED',
        amount: money('USD', '200'),
        payer: { userId: 'u-1', email: 'manager@example.test', displayName: 'Template Manager' },
        organization: { id: 'o-1', name: 'University A' },
        failureCode: null,
        createdAt: '2026-10-02T10:00:00.000Z',
        deliveredAt: '2026-10-02T10:05:00.000Z',
        releasedAt: null,
      },
    ]);
    render(<AdminFinancePage />);
    const revenue = await screen.findAllByTestId('purchase-revenue');
    // One row per currency: dollars and dinars are never added up.
    expect(revenue).toHaveLength(2);
    expect(revenue.map((cell) => cell.textContent)).toEqual([
      expect.stringContaining('0.50'),
      expect.stringContaining('0.350'),
    ]);
    expect(screen.getByText('Template Manager')).toBeTruthy();
    expect(screen.getByText('University A')).toBeTruthy();
    expect(screen.getByText(en.finance.currencyNote)).toBeTruthy();
    expect(screen.queryByText('AI_REVIEW')).toBeNull();
  });

  it('filters the purchase report by product and date range', async () => {
    staff('PALCERT_FINANCE');
    finance.prices.mockResolvedValue([]);
    render(<AdminFinancePage />);
    await waitFor(() => expect(finance.purchaseSummary).toHaveBeenCalledWith({}));
    const report = screen.getAllByRole('region', { name: en.finance.purchases })[0]!;
    fireEvent.change(within(report).getByLabelText(en.finance.product), {
      target: { value: 'AI_REVIEW' },
    });
    fireEvent.change(screen.getByLabelText(en.finance.from), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText(en.finance.to), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: en.finance.applyFilters }));
    expect(await screen.findByText(en.finance.invalidRange)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(en.finance.to), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: en.finance.applyFilters }));
    await waitFor(() =>
      expect(finance.purchaseSummary).toHaveBeenLastCalledWith({
        productCode: 'AI_REVIEW',
        from: '2026-10-05',
        to: '2026-10-31',
      }),
    );
    expect(finance.purchaseReport).toHaveBeenLastCalledWith({
      productCode: 'AI_REVIEW',
      from: '2026-10-05',
      to: '2026-10-31',
      limit: 50,
    });
  });

  it('shows no purchase report to a role that cannot read purchases', async () => {
    staff('PALCERT_AUDITOR');
    finance.prices.mockResolvedValue([]);
    render(<AdminFinancePage />);
    await screen.findByRole('button', { name: en.finance.runCheck });
    const canRead = [...ROLE('PALCERT_AUDITOR')].includes('finance:purchase:read');
    expect(screen.queryByText(en.finance.purchases) !== null).toBe(canRead);
  });

  it('adjusts a balance with a signed amount and one key per intended adjustment', async () => {
    staff('PALCERT_FINANCE');
    nav.params = { locale: 'en', userId: 'user-9' };
    admin.user.mockResolvedValue(USER);
    finance.balance.mockResolvedValue({
      ownerUserId: 'user-9',
      currency: 'USD',
      available: { currency: 'USD', minorUnits: '500' },
      reserved: { currency: 'USD', minorUnits: '0' },
      cash: { currency: 'USD', minorUnits: '500' },
      promotional: { currency: 'USD', minorUnits: '0' },
      accounts: [],
    });
    finance.payments.mockResolvedValue([]);
    finance.purchases.mockResolvedValue([]);
    finance.adjust.mockRejectedValueOnce(new ApiError('RATE_LIMITED', 'slow', 429));
    finance.adjust.mockResolvedValueOnce({});
    render(<CustomerFinancePage />);

    fireEvent.click(await screen.findByLabelText(en.customer.debit));
    fireEvent.change(await screen.findByLabelText(en.finance.amount), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: en.customer.adjust }));
    expect(await screen.findByText(en.errors['RATE_LIMITED']!)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.customer.adjust }));
    expect(await screen.findByText(en.customer.adjusted)).toBeTruthy();

    const [first, second] = finance.adjust.mock.calls.map((call) => call[0]);
    expect(first).toMatchObject({
      ownerUserId: 'user-9',
      currency: 'USD',
      creditClass: 'CASH',
      amountMinorUnits: '-200',
      reasonCode: 'CUSTOMER_REQUEST',
    });
    // The retry is the same intention, so it carries the same key.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    // And the figures are read again after money moved.
    await waitFor(() => expect(finance.balance).toHaveBeenCalledTimes(2));
  });

  it('refunds only a completed payment, and only an amount in the currency’s precision', async () => {
    staff('PALCERT_FINANCE');
    nav.params = { locale: 'en', userId: 'user-9' };
    admin.user.mockResolvedValue(USER);
    finance.balance.mockResolvedValue({
      ownerUserId: 'user-9',
      currency: 'USD',
      available: { currency: 'USD', minorUnits: '0' },
      reserved: { currency: 'USD', minorUnits: '0' },
      cash: { currency: 'USD', minorUnits: '0' },
      promotional: { currency: 'USD', minorUnits: '0' },
      accounts: [],
    });
    const payment = {
      id: 't-1',
      status: 'SUCCEEDED',
      amount: { currency: 'USD', minorUnits: '2000' },
      provider: 'stripe',
      failureCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      succeededAt: '2026-01-01T00:01:00.000Z',
      failedAt: null,
      cancelledAt: null,
    };
    finance.payments.mockResolvedValue([payment, { ...payment, id: 't-2', status: 'FAILED' }]);
    finance.purchases.mockResolvedValue([]);
    finance.refund.mockResolvedValue({});
    render(<CustomerFinancePage />);

    const refunds = await screen.findAllByRole('button', { name: en.customer.refund });
    expect(refunds).toHaveLength(1);
    fireEvent.click(refunds[0]!);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(new RegExp(en.customer.refundAmount)), {
      target: { value: '5.555' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: en.customer.refund }));
    expect(await within(dialog).findByText(en.finance.invalidAmount)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText(new RegExp(en.customer.refundAmount)), {
      target: { value: '5' },
    });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${en.customer.refundReason}`)), {
      target: { value: 'DUPLICATE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: en.customer.refund }));
    await waitFor(() =>
      expect(finance.refund).toHaveBeenCalledWith({
        topUpId: 't-1',
        amountMinorUnits: '500',
        reason: 'DUPLICATE',
      }),
    );
  });
});

describe('returning after signing in again', () => {
  it('accepts only a path in this site and this language', () => {
    expect(safeReturnPath('en', '/en/admin/organizations/org-1')).toBe(
      '/en/admin/organizations/org-1',
    );
    expect(safeReturnPath('en', 'https://evil.example/en/admin')).toBeNull();
    expect(safeReturnPath('en', '//evil.example/en/admin')).toBeNull();
    expect(safeReturnPath('en', '/en//evil.example')).toBeNull();
    expect(safeReturnPath('en', '/en/\\evil')).toBeNull();
    expect(safeReturnPath('en', 'javascript:alert(1)')).toBeNull();
    expect(safeReturnPath('en', '/ar/admin')).toBeNull();
    expect(safeReturnPath('en', '/en/login')).toBeNull();
    expect(safeReturnPath('en', null)).toBeNull();
  });
});
