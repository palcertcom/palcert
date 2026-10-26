import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EmailDeliveryView, EmailSettingsView } from '@palcert/contracts/email';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmailDeliveriesPage from '@/app/[locale]/admin/email-deliveries/page';
import EmailSettingsPage from '@/app/[locale]/admin/email-settings/page';
import { EMAIL_MESSAGES } from '@/i18n/email-messages';
import { ApiError } from '@/lib/api-client';

const nav = vi.hoisted(() => ({
  params: { locale: 'en' } as Record<string, string>,
  pathname: '/en/admin/email-settings',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(),
}));

const shell = vi.hoisted(() => ({
  state: {
    status: 'signed-in' as 'signed-in' | 'loading' | 'signed-out',
    user: { id: 'staff-1' } as { id: string } | null,
    globalPermissions: new Set<string>() as ReadonlySet<string>,
  },
}));
vi.mock('@/components/shell/shell-context', () => ({ useShell: () => shell.state }));

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  save: vi.fn(),
  sendTest: vi.fn(),
  deliveries: vi.fn(),
  delivery: vi.fn(),
}));
vi.mock('@/lib/email-api', () => ({ emailAdminApi: api }));

const en = EMAIL_MESSAGES.en;
const ADMIN = [
  'admin:email-settings:read',
  'admin:email-settings:manage',
  'admin:email-settings:test',
  'admin:email-delivery:read',
];
const TEST_KEY = 're_TESTONLY_ui_key_123456';

function view(overrides: Partial<EmailSettingsView> = {}): EmailSettingsView {
  return {
    provider: 'DISABLED',
    enabled: false,
    sendingDomain: 'palcert.com',
    fromEmail: 'no-reply@palcert.com',
    fromName: 'PalCert',
    replyToEmail: null,
    authVerificationEnabled: true,
    authPasswordResetEnabled: true,
    authInvitationEnabled: true,
    workflowEmailEnabled: true,
    deliveryTrackingEnabled: true,
    apiKeyConfigured: false,
    apiKeyDisplayHint: null,
    webhookSecretConfigured: false,
    webhookSecretDisplayHint: null,
    encryptionAvailable: true,
    isDefault: true,
    warnings: [],
    environment: 'test (localhost)',
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = { locale: 'en' };
  shell.state.status = 'signed-in';
  shell.state.globalPermissions = new Set(ADMIN);
});

describe('email settings page', () => {
  it('shows defaults, the domain note and never a key field value', async () => {
    api.settings.mockResolvedValue(view({ provider: 'RESEND' }));
    render(<EmailSettingsPage />);
    expect(await screen.findByTestId('email-defaults-notice')).toHaveTextContent(
      en.settings.defaultsNotice,
    );
    expect(screen.getByTestId('email-domain-note')).toHaveTextContent('must be verified in Resend');
    expect((screen.getByTestId('email-api-key') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('email-api-key')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('email-api-key-state')).toHaveTextContent(
      en.settings.apiKeyNotConfigured,
    );
  });

  it('shows only the masked hint for a saved key', async () => {
    api.settings.mockResolvedValue(
      view({
        provider: 'RESEND',
        enabled: true,
        apiKeyConfigured: true,
        apiKeyDisplayHint: 're_••••••••7XQ',
        isDefault: false,
      }),
    );
    render(<EmailSettingsPage />);
    expect(await screen.findByTestId('email-api-key-state')).toHaveTextContent(
      'Configured re_••••••••7XQ',
    );
  });

  it('sends a new key once, then clears it from the form, and omits a blank key', async () => {
    api.settings.mockResolvedValue(view());
    api.save.mockImplementation(async () =>
      view({
        provider: 'RESEND',
        enabled: true,
        apiKeyConfigured: true,
        apiKeyDisplayHint: 're_••••••••456',
        isDefault: false,
      }),
    );
    render(<EmailSettingsPage />);
    fireEvent.change(await screen.findByTestId('email-provider'), { target: { value: 'RESEND' } });
    fireEvent.click(screen.getByTestId('email-enabled'));
    fireEvent.change(screen.getByTestId('email-api-key'), { target: { value: TEST_KEY } });
    fireEvent.click(screen.getByTestId('email-save'));

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0]![0]).toMatchObject({
      provider: 'RESEND',
      enabled: true,
      apiKey: TEST_KEY,
    });
    await screen.findByText(en.settings.saved);
    expect((screen.getByTestId('email-api-key') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(TEST_KEY);

    fireEvent.change(screen.getByTestId('email-fromName'), { target: { value: 'PalCert Mail' } });
    fireEvent.click(screen.getByTestId('email-save'));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(api.save.mock.calls[1]![0]).not.toHaveProperty('apiKey');
  });

  it('explains when secure configuration is unavailable and disables secret inputs', async () => {
    api.settings.mockResolvedValue(
      view({ encryptionAvailable: false, warnings: ['ENCRYPTION_UNAVAILABLE'] }),
    );
    render(<EmailSettingsPage />);
    expect(await screen.findByTestId('email-encryption-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('email-api-key')).toBeDisabled();
  });

  it('is read-only for an auditor, with no save or test controls', async () => {
    shell.state.globalPermissions = new Set([
      'admin:email-settings:read',
      'admin:email-delivery:read',
    ]);
    api.settings.mockResolvedValue(view());
    render(<EmailSettingsPage />);
    expect(await screen.findByText(en.settings.readOnly)).toBeInTheDocument();
    expect(screen.queryByTestId('email-save')).toBeNull();
    expect(screen.queryByTestId('email-test')).toBeNull();
    expect(screen.getByTestId('email-provider')).toBeDisabled();
  });

  it('refuses finance staff entirely', () => {
    shell.state.globalPermissions = new Set(['finance:ledger:read']);
    render(<EmailSettingsPage />);
    expect(api.settings).not.toHaveBeenCalled();
  });

  it('sends a test only when asked, and reports a failure category', async () => {
    api.settings.mockResolvedValue(
      view({
        provider: 'RESEND',
        apiKeyConfigured: true,
        apiKeyDisplayHint: 're_••••••••7XQ',
        isDefault: false,
      }),
    );
    api.sendTest.mockResolvedValue({
      deliveryId: 'd1',
      accepted: false,
      status: 'FAILED',
      failure: 'SENDER_REJECTED',
      failureSummary: 'x',
    });
    render(<EmailSettingsPage />);
    await screen.findByTestId('email-test');
    expect(api.sendTest).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('email-test-recipient'), {
      target: { value: 'ops@example.org' },
    });
    fireEvent.change(screen.getByTestId('email-test-locale'), { target: { value: 'ar' } });
    fireEvent.click(screen.getByTestId('email-test-send'));
    await waitFor(() =>
      expect(api.sendTest).toHaveBeenCalledWith({ recipient: 'ops@example.org', locale: 'ar' }),
    );
    expect(
      await screen.findByText(en.test.failed(en.deliveries.failures.SENDER_REJECTED!)),
    ).toBeInTheDocument();
  });

  it('asks for a fresh sign-in when the API requires it', async () => {
    api.settings.mockResolvedValue(view());
    api.save.mockRejectedValue(new ApiError('REAUTHENTICATION_REQUIRED', 'x', 403));
    render(<EmailSettingsPage />);
    fireEvent.change(await screen.findByTestId('email-fromName'), { target: { value: 'Other' } });
    fireEvent.click(screen.getByTestId('email-save'));
    expect(await screen.findByRole('link', { name: /sign in again/i })).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    nav.params = { locale: 'ar' };
    api.settings.mockResolvedValue(view());
    render(<EmailSettingsPage />);
    expect(await screen.findByText(EMAIL_MESSAGES.ar.settings.save)).toBeInTheDocument();
  });
});

describe('email deliveries page', () => {
  const row: EmailDeliveryView = {
    id: 'd1',
    category: 'AUTH',
    template: 'PASSWORD_RESET',
    provider: 'resend',
    providerMessageId: 'em_1',
    recipient: 'person@example.org',
    status: 'BOUNCED',
    failureCode: 'RECIPIENT_REJECTED',
    failureSummary: 'The email provider rejected the recipient address.',
    attemptCount: 1,
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:05:00.000Z',
    acceptedAt: '2026-10-02T10:00:01.000Z',
    deliveredAt: null,
    failedAt: '2026-10-02T10:05:00.000Z',
    lastEventAt: '2026-10-02T10:05:00.000Z',
  };

  it('lists metadata, filters and paginates', async () => {
    nav.pathname = '/en/admin/email-deliveries';
    api.deliveries
      .mockResolvedValueOnce({ items: [row], nextCursor: 'c1' })
      .mockResolvedValue({ items: [], nextCursor: null });
    render(<EmailDeliveriesPage />);
    expect(await screen.findByText('person@example.org')).toBeInTheDocument();
    expect(screen.getAllByText(en.deliveries.statuses.BOUNCED!).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText(en.deliveries.loadMore));
    await waitFor(() =>
      expect(api.deliveries).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' })),
    );

    fireEvent.change(screen.getByTestId('deliveries-filter-status'), {
      target: { value: 'FAILED' },
    });
    fireEvent.click(screen.getByTestId('deliveries-apply'));
    await waitFor(() =>
      expect(api.deliveries).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'FAILED' }),
      ),
    );
    expect(await screen.findByText(en.deliveries.empty)).toBeInTheDocument();
  });
});
