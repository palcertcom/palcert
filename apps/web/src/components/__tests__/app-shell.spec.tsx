import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppFrame } from '../shell/app-frame';
import { ShellProvider } from '../shell/shell-context';
import type * as ApiClient from '@/lib/api-client';
import type { UserOrganizationResponse, UserProfileResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const nav = vi.hoisted(() => ({ pathname: '/en/documents', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.pathname,
  useParams: () => ({ locale: nav.pathname.slice(1, 3) }),
}));

const api = vi.hoisted(() => ({
  me: vi.fn(),
  logout: vi.fn(),
  mine: vi.fn(),
  unreadCount: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return {
    ...actual,
    authApi: { ...actual.authApi, me: api.me, logout: api.logout },
    organizationApi: { ...actual.organizationApi, mine: api.mine },
    notificationsApi: { ...actual.notificationsApi, unreadCount: api.unreadCount },
  };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const SELF = [
  'profile:read:self',
  'session:read:self',
  'document:read:self',
  'check:read:self',
  'certificate:read:self',
  'submission:read:self',
  'balance:read:self',
  'notification:read:self',
];

function user(): UserProfileResponse {
  return {
    id: 'u-1',
    email: 'lina@example.test',
    displayName: 'Lina Haddad',
    status: 'ACTIVE',
    preferredLocale: 'en',
    emailVerified: true,
    mfaEnrolled: false,
    mfaRequired: false,
    roles: ['SERVICE_USER'],
    permissions: SELF,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  };
}

function membership(roles: string[], status = 'ACTIVE'): UserOrganizationResponse {
  return {
    organization: { id: 'org-1', displayName: 'Birzeit University' },
    membershipId: 'm-1',
    membershipStatus: status,
    roles,
    joinedAt: '2026-01-01T00:00:00.000Z',
  } as UserOrganizationResponse;
}

function renderFrame(children: React.ReactNode = <main className="pc-page">page</main>) {
  const locale = nav.pathname.slice(1, 3) as 'en' | 'ar';
  return render(
    <ShellProvider>
      <AppFrame locale={locale}>{children}</AppFrame>
    </ShellProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = '/en/documents';
  api.me.mockResolvedValue(user());
  api.mine.mockResolvedValue([]);
  api.unreadCount.mockResolvedValue({ unread: 0 });
  api.logout.mockResolvedValue(undefined);
  window.localStorage.clear();
});

describe('Application shell', () => {
  it('shows the personal sections the user may use, with the current one marked', async () => {
    renderFrame();
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    for (const [name, href] of [
      ['Dashboard', '/en'],
      ['Documents', '/en/documents'],
      ['Checks', '/en/checks'],
      ['Certificates', '/en/certificates'],
      ['Official submissions', '/en/submissions'],
      ['Balance', '/en/balance'],
      ['Notifications', '/en/notifications'],
    ] as const) {
      expect(within(navigation).getByRole('link', { name })).toHaveAttribute('href', href);
    }
    expect(within(navigation).getByRole('link', { current: 'page' })).toHaveTextContent(
      'Documents',
    );
  });

  it('keeps public verification out of the signed-in navigation', async () => {
    renderFrame();
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(navigation).queryByRole('link', { name: /verify/i })).toBeNull();
  });

  it('shows the current organization’s sections from the roles held there', async () => {
    nav.pathname = '/en/organizations/org-1/team';
    api.mine.mockResolvedValue([membership(['ORGANIZATION_REVIEWER'])]);
    renderFrame();
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    await waitFor(() =>
      expect(
        within(navigation).getByRole('link', { name: 'Submission queue' }),
      ).toBeInTheDocument(),
    );
    expect(within(navigation).queryByRole('link', { name: /api clients/i })).toBeNull();
    expect(within(navigation).getByRole('link', { name: 'Certificates' })).toHaveAttribute(
      'href',
      '/en/certificates',
    );
    // A reviewer reads what the organization's approvals issued, under its own name.
    expect(within(navigation).getByRole('link', { name: 'Issued certificates' })).toHaveAttribute(
      'href',
      '/en/organizations/org-1/certificates',
    );
    expect(screen.getByLabelText('Switch organization')).toHaveValue('org-1');
  });

  it('offers no organization sections for a membership that is not active', async () => {
    nav.pathname = '/en/organizations/org-1';
    api.mine.mockResolvedValue([membership(['ORGANIZATION_OWNER'], 'SUSPENDED')]);
    renderFrame();
    await screen.findByLabelText('Switch organization');
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
  });

  it('signs out from the account menu and returns to sign-in', async () => {
    renderFrame();
    const trigger = await screen.findByRole('button', { name: /account menu/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(within(panel).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/en/profile',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/en/login'));
  });

  it('closes the account menu on Escape and returns focus to its button', async () => {
    renderFrame();
    const trigger = await screen.findByRole('button', { name: /account menu/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('shows the email left-to-right even in the Arabic menu', async () => {
    nav.pathname = '/ar/documents';
    renderFrame();
    const trigger = await screen.findByRole('button', { name: /قائمة الحساب/ });
    fireEvent.click(trigger);
    const email = screen.getByText('lina@example.test');
    expect(email).toHaveAttribute('dir', 'ltr');
    expect(email).toHaveClass('pc-ltr');
  });

  it('switches language to the same page', async () => {
    nav.pathname = '/en/documents/abc';
    renderFrame();
    const language = await screen.findByRole('navigation', { name: 'Language' });
    expect(within(language).getByRole('link')).toHaveAttribute('href', '/ar/documents/abc');
  });

  it('opens and closes the navigation drawer', async () => {
    renderFrame();
    const open = await screen.findByRole('button', { name: 'Open navigation' });
    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(open).toHaveFocus();
  });

  it('shows the real unread count on the bell and in the sidebar', async () => {
    api.unreadCount.mockResolvedValue({ unread: 3 });
    renderFrame();
    expect(await screen.findByTestId('notification-unread-count')).toHaveTextContent('3');
    expect(await screen.findByText('3 unread notifications')).toBeInTheDocument();
  });

  it('shows a breadcrumb on pages below a section', async () => {
    nav.pathname = '/en/documents/abc';
    renderFrame();
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Documents' })).toHaveAttribute(
      'href',
      '/en/documents',
    );
  });

  it('keeps the page beside the frame, never inside a frame element', async () => {
    // Hydration relies on this: the page's code can arrive after the frame's,
    // and only directly under <body> does React wait for it rather than
    // discarding the document. The frame is a fragment of <body> children.
    const { container } = renderFrame();
    const topbar = await screen.findByRole('banner');
    const page = screen.getByRole('main');
    expect(page.parentElement).toBe(container);
    expect(topbar.parentElement).toBe(container);
  });

  it('frames sign-in and public pages the same way', async () => {
    for (const path of ['/en/login', '/en/verify']) {
      nav.pathname = path;
      const { container, unmount } = renderFrame();
      expect(screen.getByRole('main').parentElement).toBe(container);
      unmount();
    }
  });

  it('keeps the page’s own main landmark and a working skip link', async () => {
    renderFrame();
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#pc-content',
    );
  });

  it('offers sign-in instead of navigation when nobody is signed in', async () => {
    api.me.mockRejectedValue(new ApiError('UNAUTHENTICATED', 'no session', 401));
    renderFrame();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/en/login',
    );
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(screen.queryByTestId('notification-unread-count')).toBeNull();
  });

  it('treats a profile response with no body as signed out, not as a crash', async () => {
    // A fetch the browser cancelled mid-read while navigating parses to
    // nothing; reading permissions off it used to throw (Firefox, QA matrix).
    api.me.mockResolvedValue(undefined);
    renderFrame();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });

  it('is in Arabic for the Arabic locale', async () => {
    nav.pathname = '/ar/documents';
    renderFrame();
    const navigation = await screen.findByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(navigation).getByRole('link', { name: 'التقديمات الرسمية' })).toHaveAttribute(
      'href',
      '/ar/submissions',
    );
  });
});

describe('Sign-in frame', () => {
  it('frames the sign-in page with a way to register and no app navigation', async () => {
    nav.pathname = '/en/login';
    renderFrame();
    expect(screen.getByRole('link', { name: /create a new account/i })).toHaveAttribute(
      'href',
      '/en/register',
    );
    expect(screen.getByRole('img', { name: /academic documents/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });
});

describe('Public frame', () => {
  it('shows certificate verification without account navigation', async () => {
    nav.pathname = '/en/verify';
    api.me.mockRejectedValue(new ApiError('UNAUTHENTICATED', 'no session', 401));
    renderFrame();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });
});
