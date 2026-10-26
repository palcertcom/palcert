import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApiClientsPage from '@/app/[locale]/organizations/[organizationId]/api-clients/page';
import { ApiClientSecretPanel } from '../api-client-secret';
import { getApiClientsMessages } from '@/i18n/api-clients-messages';
import type * as ApiClient from '@/lib/api-client';
import type { ApiClientResponse, ApiClientSecretResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/organizations/org-1/api-clients',
  useParams: () => ({ locale: 'en', organizationId: 'org-1' }),
}));

const api = vi.hoisted(() => ({
  scopes: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  rotateSecret: vi.fn(),
  setEnabled: vi.fn(),
  revoke: vi.fn(),
}));

/**
 * The shell loads the organization and the caller's permissions; this suite is
 * about the credential screen, so it is replaced with a fixed state whose
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
  return { ...actual, apiClientsApi: api };
});

const en = getApiClientsMessages('en');

const CLIENT: ApiClientResponse = {
  apiClientId: 'client-1',
  organizationId: 'org-1',
  clientId: 'pcid_0123456789abcdef0123456789abcdef',
  displayName: 'Student records integration',
  description: null,
  status: 'ACTIVE',
  scopes: ['organization:read', 'submissions:read'],
  createdAt: '2026-06-01T12:00:00.000Z',
  createdByUserId: 'user-1',
  expiresAt: null,
  revokedAt: null,
  disabledAt: null,
  lastUsedAt: null,
  liveSecretCount: 1,
  rotationOverlapEndsAt: null,
};

const SECRET = `pcsk_${'a'.repeat(64)}`;

const REVEAL: ApiClientSecretResponse = {
  client: CLIENT,
  clientSecret: SECRET,
  previousSecretRetiresAt: null,
};

const ALL_PERMISSIONS = new Set([
  'integration:api-client:read',
  'integration:api-client:manage',
  'integration:api-client:secret:issue',
]);

beforeEach(() => {
  vi.clearAllMocks();
  shellPermissions.value = ALL_PERMISSIONS;
  api.list.mockResolvedValue([CLIENT]);
  api.scopes.mockResolvedValue([
    { scope: 'organization:read', operations: ['organization.profile.read'], write: false },
    { scope: 'submissions:read', operations: ['submission.list'], write: false },
    { scope: 'certificates:read', operations: ['certificate.read'], write: false },
    { scope: 'webhooks:read', operations: ['webhook.endpoint.list'], write: false },
  ]);
});

describe('API clients screen', () => {
  it('lists a client by its public id and never shows a secret', async () => {
    render(<ApiClientsPage />);

    await screen.findByText(CLIENT.displayName);
    expect(screen.getByText(CLIENT.clientId)).toBeTruthy();
    expect(screen.getByTestId(`status-${CLIENT.apiClientId}`).textContent).toBe(en.statuses.ACTIVE);
    // There is no field on the list response that could carry one, and the
    // screen renders nothing secret-shaped even so.
    expect(document.body.textContent).not.toContain('pcsk_');
  });

  it('says a credential has never been used rather than showing an empty cell', async () => {
    render(<ApiClientsPage />);
    await screen.findByText(CLIENT.displayName);
    expect(document.body.textContent).toContain(en.neverUsed);
    expect(document.body.textContent).toContain(en.noExpiry);
  });

  it('offers the scope catalogue the API serves, with what each one exposes', async () => {
    render(<ApiClientsPage />);

    await screen.findByLabelText(new RegExp(en.scopeNames['certificates:read']!));
    // Not hard-coded into the screen: the catalogue came from the API, so a
    // scope the server does not offer cannot appear here.
    expect(api.scopes).toHaveBeenCalledWith('org-1');
    expect(document.body.textContent).toContain(en.scopeDescriptions['submissions:read']);
  });

  it('shows the secret once on creation, and only then', async () => {
    api.create.mockResolvedValue(REVEAL);
    render(<ApiClientsPage />);

    fireEvent.change(await screen.findByLabelText(en.displayNameLabel), {
      target: { value: 'Student records integration' },
    });
    fireEvent.click(screen.getByLabelText(new RegExp(en.scopeNames['organization:read']!)));
    fireEvent.click(screen.getByRole('button', { name: en.create }));

    await waitFor(() => {
      expect(screen.getByTestId('api-client-secret').textContent).toBe(SECRET);
    });
    // The warning is above the value, so somebody who copies and closes has
    // already read it.
    expect(document.body.textContent).toContain(en.secretWarning);

    fireEvent.click(screen.getByRole('button', { name: en.secretDismiss }));
    await waitFor(() => {
      expect(screen.queryByTestId('api-client-secret')).toBeNull();
    });
  });

  it('sends the chosen scopes sorted, with an idempotency key', async () => {
    api.create.mockResolvedValue(REVEAL);
    render(<ApiClientsPage />);

    fireEvent.change(await screen.findByLabelText(en.displayNameLabel), {
      target: { value: 'Registry sync' },
    });
    fireEvent.click(screen.getByLabelText(new RegExp(en.scopeNames['submissions:read']!)));
    fireEvent.click(screen.getByLabelText(new RegExp(en.scopeNames['organization:read']!)));
    fireEvent.click(screen.getByRole('button', { name: en.create }));

    await waitFor(() => {
      expect(api.create).toHaveBeenCalled();
    });
    const [, body, key] = api.create.mock.calls[0] as [string, { scopes: string[] }, string];
    expect(body.scopes).toEqual(['organization:read', 'submissions:read']);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(8);
  });

  it('asks before revoking, and names the reversible alternative', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ApiClientsPage />);

    fireEvent.click(await screen.findByTestId(`revoke-${CLIENT.apiClientId}`));

    expect(confirm).toHaveBeenCalledWith(en.revokeConfirm);
    // Declined, so nothing happened. A confirmation that fires the request
    // anyway is worse than none.
    expect(api.revoke).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('revokes once the confirmation is accepted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.revoke.mockResolvedValue({ ...CLIENT, status: 'REVOKED' });
    render(<ApiClientsPage />);

    fireEvent.click(await screen.findByTestId(`revoke-${CLIENT.apiClientId}`));
    await waitFor(() => {
      expect(api.revoke).toHaveBeenCalledWith('org-1', CLIENT.apiClientId);
    });
    confirm.mockRestore();
  });

  it('offers no actions at all on a revoked client', async () => {
    api.list.mockResolvedValue([{ ...CLIENT, status: 'REVOKED', revokedAt: CLIENT.createdAt }]);
    render(<ApiClientsPage />);

    await screen.findByText(CLIENT.displayName);
    // Not a disabled button: a greyed-out control implies the thing could come
    // back, and revocation is final.
    expect(screen.queryByTestId(`revoke-${CLIENT.apiClientId}`)).toBeNull();
    expect(screen.queryByTestId(`rotate-${CLIENT.apiClientId}`)).toBeNull();
    expect(screen.queryByTestId(`toggle-${CLIENT.apiClientId}`)).toBeNull();
  });

  it('shows a reader the list and none of the controls', async () => {
    shellPermissions.value = new Set(['integration:api-client:read']);
    render(<ApiClientsPage />);

    await screen.findByText(CLIENT.displayName);
    expect(screen.queryByTestId(`revoke-${CLIENT.apiClientId}`)).toBeNull();
    expect(screen.queryByTestId(`rotate-${CLIENT.apiClientId}`)).toBeNull();
    expect(screen.queryByRole('button', { name: en.create })).toBeNull();
  });

  it('translates a refusal rather than showing its code', async () => {
    const { ApiError } = await import('@/lib/api-client');
    api.list.mockRejectedValue(
      new ApiError('API_CLIENT_ROTATION_IN_PROGRESS', 'A rotation is already running.', 409),
    );
    render(<ApiClientsPage />);

    await waitFor(() => {
      expect(document.body.textContent).toContain(en.errors.API_CLIENT_ROTATION_IN_PROGRESS);
    });
    expect(document.body.textContent).not.toContain('API_CLIENT_ROTATION_IN_PROGRESS');
  });
});

describe('the secret panel', () => {
  it('says nothing about a previous secret on a create', () => {
    render(<ApiClientSecretPanel locale="en" reveal={REVEAL} kind="create" onDismiss={() => {}} />);
    // There was no previous secret, so a line about one would describe
    // something that never existed.
    expect(screen.queryByTestId('api-client-previous-retires')).toBeNull();
  });

  it('says the previous secret stopped immediately when a rotation had no overlap', () => {
    render(<ApiClientSecretPanel locale="en" reveal={REVEAL} kind="rotate" onDismiss={() => {}} />);
    expect(screen.getByTestId('api-client-previous-retires').textContent).toBe(
      en.secretPreviousRetiredNow,
    );
  });

  it('names when the previous secret stops when there is an overlap', () => {
    render(
      <ApiClientSecretPanel
        locale="en"
        reveal={{ ...REVEAL, previousSecretRetiresAt: '2026-06-01T18:00:00.000Z' }}
        kind="rotate"
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('api-client-previous-retires').textContent).toContain(
      en.secretPreviousRetires,
    );
  });

  it('keeps the credential left-to-right inside an Arabic page', () => {
    render(<ApiClientSecretPanel locale="ar" reveal={REVEAL} kind="create" onDismiss={() => {}} />);
    // The bidirectional algorithm would reorder an opaque Latin string's
    // trailing characters around the surrounding Arabic, and somebody copying
    // it by eye would copy something that does not work.
    expect(screen.getByTestId('api-client-secret').getAttribute('dir')).toBe('ltr');
  });

  it('renders the Arabic catalogue when the locale is Arabic', () => {
    const ar = getApiClientsMessages('ar');
    render(<ApiClientSecretPanel locale="ar" reveal={REVEAL} kind="create" onDismiss={() => {}} />);
    expect(document.body.textContent).toContain(ar.secretWarning);
    expect(document.body.textContent).not.toContain(en.secretWarning);
  });
});
