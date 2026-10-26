import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WebhooksPage from '@/app/[locale]/organizations/[organizationId]/webhooks/page';
import WebhookEndpointPage from '@/app/[locale]/organizations/[organizationId]/webhooks/[endpointId]/page';
import { WebhookSecretPanel } from '../webhook-secret';
import { getWebhooksMessages } from '@/i18n/webhooks-messages';
import type * as ApiClient from '@/lib/api-client';
import type { WebhookEndpointResponse, WebhookSecretResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/en/organizations/org-1/webhooks',
  useParams: () => ({ locale: 'en', organizationId: 'org-1', endpointId: 'endpoint-1' }),
}));

const api = vi.hoisted(() => ({
  listEndpoints: vi.fn(),
  createEndpoint: vi.fn(),
  getEndpoint: vi.fn(),
  deliveries: vi.fn(),
  verificationAttempts: vi.fn(),
  configVersions: vi.fn(),
  rotationPending: vi.fn(),
  rotateSecret: vi.fn(),
  test: vi.fn(),
  verify: vi.fn(),
  updateUrl: vi.fn(),
  replay: vi.fn(),
  attempts: vi.fn(),
  lifecycle: vi.fn(),
  replaceSubscriptions: vi.fn(),
  operations: vi.fn(),
  updateDescription: vi.fn(),
}));

/**
 * The shell loads the organization and the caller's permissions; this suite is
 * about the webhook screens, so it is replaced with a fixed state whose
 * permission set each test chooses.
 */
const shellPermissions = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock('@/components/organization-shell', () => ({
  OrganizationShell: ({ children }: { children: (state: unknown) => unknown }) =>
    children({
      organizationId: 'org-1',
      locale: 'en',
      permissions: shellPermissions.value,
      organization: {},
      messages: {},
      reload: () => undefined,
    }),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, webhooksApi: api };
});

const en = getWebhooksMessages('en');

const ENDPOINT: WebhookEndpointResponse = {
  id: 'endpoint-1',
  organizationId: 'org-1',
  description: 'Primary integration',
  status: 'PENDING_VERIFICATION',
  destination: '',
  subscribedEventTypes: ['submission.approved'],
  configVersion: 0,
  configStatus: 'PENDING',
  verifiedAt: null,
  createdAt: '2026-06-01T12:00:00.000Z',
  updatedAt: '2026-06-01T12:00:00.000Z',
  pendingConfig: {
    configVersionId: 'config-1',
    destination: 'https://receiver.example',
    subscribedEventTypes: ['submission.approved'],
    configVersion: 1,
    status: 'PENDING',
    lastVerificationError: null,
    lastVerificationAt: null,
    createdAt: '2026-06-01T12:00:00.000Z',
  },
};

/** The same endpoint once a handshake has answered: rotate and test are live. */
const ACTIVE_ENDPOINT: WebhookEndpointResponse = {
  ...ENDPOINT,
  status: 'ACTIVE',
  destination: 'https://receiver.example',
  configVersion: 1,
  configStatus: 'VERIFIED',
  verifiedAt: '2026-06-01T12:00:00.000Z',
  pendingConfig: null,
};

const SECRET: WebhookSecretResponse = {
  endpointId: 'endpoint-1',
  operationId: 'operation-1',
  configVersion: 1,
  signingSecret: 'whsec_TESTSECRETVALUE',
  recoverableUntil: '2026-06-02T12:00:00.000Z',
};

describe('Webhook screens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    shellPermissions.value = new Set(['integration:webhook:read', 'integration:webhook:manage']);
    api.listEndpoints.mockResolvedValue([ENDPOINT]);
    api.getEndpoint.mockResolvedValue(ACTIVE_ENDPOINT);
    api.deliveries.mockResolvedValue({ items: [], nextCursor: null });
    api.verificationAttempts.mockResolvedValue([]);
    api.configVersions.mockResolvedValue([]);
    api.rotationPending.mockResolvedValue({
      endpointId: 'endpoint-1',
      currentConfigVersion: 1,
      unsettledOldConfigDeliveries: 0,
    });
    api.operations.mockResolvedValue([]);
  });

  it('lists the management log with each outcome', async () => {
    api.operations.mockResolvedValue([
      {
        id: 'op-1',
        operation: 'ROTATE_SECRET',
        endpointId: 'endpoint-1',
        configVersionId: null,
        deliveryId: null,
        settledAt: '2026-06-01T12:01:00.000Z',
        settledErrorCode: null,
        createdAt: '2026-06-01T12:00:00.000Z',
      },
      {
        id: 'op-2',
        operation: 'VERIFY_CONFIG',
        endpointId: 'endpoint-1',
        configVersionId: 'config-1',
        deliveryId: null,
        settledAt: null,
        settledErrorCode: null,
        createdAt: '2026-06-01T12:02:00.000Z',
      },
    ]);
    render(<WebhookEndpointPage />);
    const log = await screen.findByTestId('operations-log');
    expect(log.textContent).toContain(en.operationKinds['ROTATE_SECRET']);
    expect(log.textContent).toContain(en.operationSettled);
    expect(log.textContent).toContain(en.operationPending);
    expect(api.operations).toHaveBeenCalledWith('org-1', 'endpoint-1');
  });

  it('renames an endpoint for a manager and hides renaming from a reader', async () => {
    api.updateDescription.mockResolvedValue(undefined);
    const { unmount } = render(<WebhookEndpointPage />);
    const input = await screen.findByLabelText(en.descriptionLabel);
    fireEvent.change(input, { target: { value: 'Registrar feed' } });
    fireEvent.click(screen.getByText(en.rename));
    await waitFor(() => {
      expect(api.updateDescription).toHaveBeenCalledWith('org-1', 'endpoint-1', 'Registrar feed');
    });
    expect(await screen.findByText(en.renamed)).toBeTruthy();
    unmount();

    shellPermissions.value = new Set(['integration:webhook:read']);
    render(<WebhookEndpointPage />);
    await screen.findByTestId('endpoint-status');
    expect(screen.queryByText(en.rename)).toBeNull();
  });

  it('never shows a pending destination as the live one', async () => {
    render(<WebhooksPage />);

    await waitFor(() => {
      expect(screen.getByText('Primary integration')).toBeTruthy();
    });
    // The endpoint has never verified, so the list says so rather than showing
    // the URL somebody typed — an administrator who reads their new URL here
    // stops watching the old one.
    expect(screen.getByText(en.noDestination)).toBeTruthy();
    expect(screen.queryByText('https://receiver.example')).toBeNull();
  });

  it('hides the create form from somebody who may only read', async () => {
    shellPermissions.value = new Set(['integration:webhook:read']);
    render(<WebhooksPage />);

    await waitFor(() => {
      expect(screen.getByText('Primary integration')).toBeTruthy();
    });
    expect(screen.queryByText(en.create)).toBeNull();
  });

  it('shows a created secret once and puts it nowhere that outlives the page', async () => {
    api.createEndpoint.mockResolvedValue(SECRET);
    render(<WebhooksPage />);

    await waitFor(() => {
      expect(screen.getByText('Primary integration')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(en.descriptionLabel), {
      target: { value: 'Primary integration' },
    });
    fireEvent.change(screen.getByLabelText(en.urlLabel), {
      target: { value: 'https://receiver.example/hook' },
    });
    fireEvent.click(screen.getByText(en.create));

    await waitFor(() => {
      expect(screen.getByTestId('webhook-signing-secret').textContent).toBe(SECRET.signingSecret);
    });

    // The warning is above the value, not below it: somebody who has already
    // copied and closed the panel never reads what was underneath.
    expect(screen.getByText(en.secretWarning)).toBeTruthy();

    // Nothing that outlives the page holds it.
    expect(JSON.stringify(localStorage)).not.toContain('whsec_');
    expect(JSON.stringify(sessionStorage)).not.toContain('whsec_');
    expect(window.location.href).not.toContain('whsec_');
    expect(document.cookie).not.toContain('whsec_');
  });

  it('stops showing the secret once it is dismissed', async () => {
    const onDismiss = vi.fn();
    render(<WebhookSecretPanel locale="en" secret={SECRET} onDismiss={onDismiss} />);

    expect(screen.getByTestId('webhook-signing-secret')).toBeTruthy();
    fireEvent.click(screen.getByText(en.secretDismiss));
    expect(onDismiss).toHaveBeenCalled();
  });

  /**
   * A lost response is the ordinary failure of a mutation over the internet,
   * and the browser is where it happens. Retrying the *same* action has to
   * carry the same key, or the server sees a second intention and creates a
   * second endpoint or a second secret.
   */
  describe('lost responses', () => {
    async function fillCreateForm(): Promise<void> {
      await waitFor(() => {
        expect(screen.getByText('Primary integration')).toBeTruthy();
      });
      fireEvent.change(screen.getByLabelText(en.descriptionLabel), {
        target: { value: 'Primary integration' },
      });
      fireEvent.change(screen.getByLabelText(en.urlLabel), {
        target: { value: 'https://receiver.example/hook' },
      });
    }

    it('retries a create with the key the first attempt used', async () => {
      api.createEndpoint
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(SECRET);
      render(<WebhooksPage />);
      await fillCreateForm();

      fireEvent.click(screen.getByText(en.create));
      await waitFor(() => {
        expect(api.createEndpoint).toHaveBeenCalledTimes(1);
      });
      // The same button, the same form: one intention, answered twice.
      fireEvent.click(screen.getByText(en.create));
      await waitFor(() => {
        expect(api.createEndpoint).toHaveBeenCalledTimes(2);
      });

      expect(api.createEndpoint.mock.calls[1]![2]).toBe(api.createEndpoint.mock.calls[0]![2]);
      expect(api.createEndpoint.mock.calls[0]![2]).toEqual(expect.any(String));
      // Never in the URL, where it would be copied into a bug report.
      expect(window.location.href).not.toContain(api.createEndpoint.mock.calls[0]![2]);
    });

    it('gives a genuinely new create its own key', async () => {
      api.createEndpoint.mockResolvedValue(SECRET);
      render(<WebhooksPage />);
      await fillCreateForm();

      fireEvent.click(screen.getByText(en.create));
      await waitFor(() => {
        expect(api.createEndpoint).toHaveBeenCalledTimes(1);
      });

      // A second endpoint is a second intention, not a retry of the first.
      await fillCreateForm();
      fireEvent.click(screen.getByText(en.create));
      await waitFor(() => {
        expect(api.createEndpoint).toHaveBeenCalledTimes(2);
      });

      expect(api.createEndpoint.mock.calls[1]![2]).not.toBe(api.createEndpoint.mock.calls[0]![2]);
    });

    it('changes the key when the request itself changes', async () => {
      api.createEndpoint.mockRejectedValue(new Error('refused'));
      render(<WebhooksPage />);
      await fillCreateForm();

      fireEvent.click(screen.getByText(en.create));
      await waitFor(() => {
        expect(api.createEndpoint).toHaveBeenCalledTimes(1);
      });
      // Correcting the URL before pressing again is a different request, and
      // reusing the key for it would be refused as a reuse.
      fireEvent.change(screen.getByLabelText(en.urlLabel), {
        target: { value: 'https://receiver-two.example/hook' },
      });
      fireEvent.click(screen.getByText(en.create));
      await waitFor(() => {
        expect(api.createEndpoint).toHaveBeenCalledTimes(2);
      });

      expect(api.createEndpoint.mock.calls[1]![2]).not.toBe(api.createEndpoint.mock.calls[0]![2]);
    });

    it('retries a rotation with the key the first attempt used, and starts fresh after one succeeds', async () => {
      shellPermissions.value = new Set([
        'integration:webhook:read',
        'integration:webhook:manage',
        'integration:webhook:secret:rotate',
      ]);
      api.rotateSecret
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValue(SECRET);
      render(<WebhookEndpointPage />);
      await waitFor(() => {
        expect(screen.getByText(en.rotate)).toBeTruthy();
      });

      fireEvent.click(screen.getByText(en.rotate));
      await waitFor(() => {
        expect(api.rotateSecret).toHaveBeenCalledTimes(1);
      });
      fireEvent.click(screen.getByText(en.rotate));
      await waitFor(() => {
        expect(api.rotateSecret).toHaveBeenCalledTimes(2);
      });

      // Same intention, same key — otherwise the retry mints a second secret
      // and the receiver an administrator just configured is already wrong.
      expect(api.rotateSecret.mock.calls[1]![2]).toBe(api.rotateSecret.mock.calls[0]![2]);

      await waitFor(() => {
        expect(screen.getByTestId('webhook-signing-secret')).toBeTruthy();
      });
      fireEvent.click(screen.getByText(en.rotate));
      await waitFor(() => {
        expect(api.rotateSecret).toHaveBeenCalledTimes(3);
      });
      // A deliberate second rotation is a new decision, so a new key.
      expect(api.rotateSecret.mock.calls[2]![2]).not.toBe(api.rotateSecret.mock.calls[0]![2]);

      expect(JSON.stringify(localStorage)).not.toContain('whsec_');
      expect(JSON.stringify(sessionStorage)).not.toContain('whsec_');
    });

    it('retries a control message with the key the first attempt used', async () => {
      api.test.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue({
        deliveryId: 'delivery-1',
        operationId: 'operation-2',
      });
      render(<WebhookEndpointPage />);
      await waitFor(() => {
        expect(screen.getByText(en.test)).toBeTruthy();
      });

      fireEvent.click(screen.getByText(en.test));
      await waitFor(() => {
        expect(api.test).toHaveBeenCalledTimes(1);
      });
      fireEvent.click(screen.getByText(en.test));
      await waitFor(() => {
        expect(api.test).toHaveBeenCalledTimes(2);
      });

      expect(api.test.mock.calls[1]![2]).toBe(api.test.mock.calls[0]![2]);

      // And once it lands, the next test message is a new one.
      fireEvent.click(screen.getByText(en.test));
      await waitFor(() => {
        expect(api.test).toHaveBeenCalledTimes(3);
      });
      expect(api.test.mock.calls[2]![2]).not.toBe(api.test.mock.calls[0]![2]);
    });
  });

  it('renders Arabic labels and reads right-to-left', () => {
    const ar = getWebhooksMessages('ar');
    render(<WebhookSecretPanel locale="ar" secret={SECRET} onDismiss={() => undefined} />);

    expect(screen.getByText(ar.secretTitle)).toBeTruthy();
    expect(screen.getByText(ar.secretWarning)).toBeTruthy();
    // The catalogue is Arabic; direction is set by the locale layout, which the
    // locale suite covers. What matters here is that no English leaked through.
    expect(ar.secretTitle).not.toBe(en.secretTitle);
  });
});
