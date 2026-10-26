import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationBell } from '../notification-bell';
import NotificationsPage from '@/app/[locale]/notifications/page';
import NotificationPreferencesPage from '@/app/[locale]/notifications/preferences/page';
import { getNotificationsMessages } from '@/i18n/notifications-messages';
import type * as ApiClient from '@/lib/api-client';
import type { NotificationPreferenceResponse, UserNotificationResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/en/notifications',
  useParams: () => ({ locale: 'en' }),
}));

const api = vi.hoisted(() => ({
  list: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  preferences: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, notificationsApi: api };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getNotificationsMessages('en');
/** Type labels are a Record<string, string>, so index reads need narrowing. */
function errorLabel(code: string): string {
  const label = en.errors[code];
  if (label === undefined) throw new Error(`no error label for ${code}`);
  return label;
}
function typeLabel(type: string): string {
  const label = en.types[type];
  if (label === undefined) throw new Error(`no label for ${type}`);
  return label;
}

const ar = getNotificationsMessages('ar');

function notification(overrides: Partial<UserNotificationResponse> = {}): UserNotificationResponse {
  return {
    id: 'n-1',
    notificationType: 'SUBMISSION_APPROVED',
    title: 'Your submission was approved',
    body: 'The institution has approved your submission.',
    locale: 'en',
    deepLink: '/en/submissions/sub-1',
    createdAt: '2026-06-01T12:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

function preference(
  type: string,
  overrides: Partial<NotificationPreferenceResponse> = {},
): NotificationPreferenceResponse {
  return { notificationType: type, emailEnabled: true, mandatory: false, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.unreadCount.mockResolvedValue({ unread: 0 });
  api.preferences.mockResolvedValue([]);
});

describe('Notification centre', () => {
  it('lists what happened and links to the page that holds the detail', async () => {
    api.list.mockResolvedValue({ items: [notification()], nextCursor: null });

    render(<NotificationsPage />);

    await screen.findByText(typeLabel('SUBMISSION_APPROVED'));
    const open = screen.getByRole('link', { name: en.open });
    // The route the notification carried, unchanged. Never rewritten into an
    // absolute URL, and never a storage link.
    expect(open).toHaveAttribute('href', '/en/submissions/sub-1');
  });

  it('says so plainly when there is nothing rather than showing an empty list', async () => {
    render(<NotificationsPage />);
    await screen.findByText(en.empty);
  });

  it('marks one as read without offering to mark it unread again', async () => {
    api.list.mockResolvedValue({ items: [notification()], nextCursor: null });
    api.markRead.mockResolvedValue(notification({ readAt: '2026-06-01T13:00:00.000Z' }));

    render(<NotificationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: en.markRead }));

    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith('n-1'));
    // read_at is the first time somebody saw it. An inbox that could rewind it
    // would record what the reader wanted rather than what happened.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: en.markRead })).not.toBeInTheDocument(),
    );
  });

  it('shows a message a person can act on when the inbox will not load', async () => {
    api.list.mockRejectedValue(new ApiError('UNKNOWN', 'boom', 500));
    render(<NotificationsPage />);
    await screen.findByText(en.genericError);
  });
});

describe('Notification preferences', () => {
  it('lists every type, including ones never touched', async () => {
    api.preferences.mockResolvedValue([
      preference('SUBMISSION_APPROVED'),
      preference('CERTIFICATE_REVOKED', { mandatory: true }),
    ]);

    render(<NotificationPreferencesPage />);

    await screen.findByText(typeLabel('SUBMISSION_APPROVED'));
    expect(screen.getByText(typeLabel('CERTIFICATE_REVOKED'))).toBeInTheDocument();
  });

  it('gives the mandatory type no switch, and says why', async () => {
    api.preferences.mockResolvedValue([
      preference('SUBMISSION_APPROVED'),
      preference('CERTIFICATE_REVOKED', { mandatory: true }),
    ]);

    render(<NotificationPreferencesPage />);

    await screen.findByText(en.alwaysOn);
    // A disabled control with no explanation reads as a bug rather than a
    // decision, so the reason is on the page.
    expect(screen.getByText(en.mandatoryNote)).toBeInTheDocument();
    // One switch for the optional type, and none for the mandatory one.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('turns an optional type off', async () => {
    api.preferences.mockResolvedValue([preference('SUBMISSION_APPROVED')]);
    api.setPreference.mockResolvedValue(preference('SUBMISSION_APPROVED', { emailEnabled: false }));

    render(<NotificationPreferencesPage />);
    fireEvent.click(await screen.findByRole('checkbox'));

    await waitFor(() =>
      expect(api.setPreference).toHaveBeenCalledWith('SUBMISSION_APPROVED', false),
    );
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });

  it('explains a refusal in the reader’s own language', async () => {
    api.preferences.mockResolvedValue([preference('SUBMISSION_APPROVED')]);
    api.setPreference.mockRejectedValue(
      new ApiError('NOTIFICATION_TYPE_MANDATORY', 'refused', 422),
    );

    render(<NotificationPreferencesPage />);
    fireEvent.click(await screen.findByRole('checkbox'));

    await screen.findByText(errorLabel('NOTIFICATION_TYPE_MANDATORY'));
    // And the Arabic catalogue has its own sentence rather than falling back.
    expect(ar.errors.NOTIFICATION_TYPE_MANDATORY).not.toBe(
      errorLabel('NOTIFICATION_TYPE_MANDATORY'),
    );
  });
});

describe('Notification bell', () => {
  it('shows the unread count', async () => {
    api.unreadCount.mockResolvedValue({ unread: 3 });
    render(<NotificationBell locale="en" />);
    expect(await screen.findByTestId('notification-unread-count')).toHaveTextContent('3');
  });

  it('shows no number when nothing is unread', async () => {
    api.unreadCount.mockResolvedValue({ unread: 0 });
    render(<NotificationBell locale="en" />);
    await screen.findByText(en.bellLabel);
    expect(screen.queryByTestId('notification-unread-count')).not.toBeInTheDocument();
  });

  it('renders nothing at all for somebody with no inbox', async () => {
    // A signed-out visitor meeting an error badge in the header would be told
    // that something is broken when in fact nothing is.
    api.unreadCount.mockRejectedValue(new ApiError('UNAUTHENTICATED', 'no session', 401));
    const { container } = render(<NotificationBell locale="en" />);
    await waitFor(() => expect(api.unreadCount).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
