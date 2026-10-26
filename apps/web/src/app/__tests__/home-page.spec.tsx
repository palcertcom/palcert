import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../[locale]/page';
import LocaleLayout from '../[locale]/layout';
import { ShellProvider } from '@/components/shell/shell-context';
import { LANDING_MESSAGES } from '@/i18n/landing-messages';
import { SHELL_MESSAGES } from '@/i18n/shell-messages';
import type * as ApiClient from '@/lib/api-client';
import type { UserProfileResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en',
  useParams: () => ({ locale: 'en' }),
  notFound: () => {
    throw new Error('not found');
  },
}));

// Whether the request carries a session cookie; only its presence is read.
const session = vi.hoisted(() => ({ cookie: false }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ has: () => session.cookie }),
}));

const api = vi.hoisted(() => ({
  me: vi.fn(),
  mine: vi.fn(),
  documents: vi.fn(),
  checks: vi.fn(),
  submissions: vi.fn(),
  certificates: vi.fn(),
  balance: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return {
    ...actual,
    authApi: { ...actual.authApi, me: api.me },
    organizationApi: { ...actual.organizationApi, mine: api.mine },
    documentsApi: { ...actual.documentsApi, list: api.documents },
    checksApi: { ...actual.checksApi, list: api.checks },
    submissionsApi: { ...actual.submissionsApi, list: api.submissions },
    certificatesApi: { ...actual.certificatesApi, list: api.certificates },
    balanceApi: { ...actual.balanceApi, balance: api.balance },
  };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

function user(overrides: Partial<UserProfileResponse> = {}): UserProfileResponse {
  return {
    id: 'u-1',
    email: 'lina@example.test',
    displayName: 'Lina',
    status: 'ACTIVE',
    preferredLocale: 'en',
    emailVerified: true,
    mfaEnrolled: false,
    mfaRequired: false,
    roles: ['SERVICE_USER'],
    permissions: [
      'document:read:self',
      'document:write:self',
      'check:read:self',
      'check:create:self',
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

async function renderHome(locale: 'en' | 'ar') {
  return render(
    <ShellProvider>{await HomePage({ params: Promise.resolve({ locale }) })}</ShellProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.mine.mockResolvedValue([]);
  api.documents.mockResolvedValue({ items: [], nextCursor: null });
  api.checks.mockResolvedValue({ items: [], nextCursor: null });
  api.submissions.mockResolvedValue([]);
  api.certificates.mockResolvedValue([]);
  api.balance.mockRejectedValue(new Error('not configured'));
});

describe('HomePage, signed out', () => {
  beforeEach(() => {
    session.cookie = false;
    api.me.mockRejectedValue(new ApiError('UNAUTHENTICATED', 'no session', 401));
  });

  it('is rendered in full without waiting for the session (server-renderable)', async () => {
    // No cookie: the page is the public homepage from the first render, so
    // the server's HTML already holds it — no loading state to hydrate.
    await renderHome('en');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      LANDING_MESSAGES.en.hero.title,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('header.pc-lp-header')).not.toBeNull();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('falls back to the public homepage when a stale cookie turns out to be signed out', async () => {
    session.cookie = true;
    await renderHome('en');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      LANDING_MESSAGES.en.hero.title,
    );
    expect(api.documents).not.toHaveBeenCalled();
  });

  it('is PalCert’s front door in English', async () => {
    await renderHome('en');
    const en = LANDING_MESSAGES.en;
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(en.hero.title);
    expect(screen.getByText(en.hero.lead)).toBeInTheDocument();
    // The six stages, in order, as a list.
    const stages = within(screen.getByRole('region', { name: en.workflow.title }));
    expect(stages.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Define',
      'Check',
      'Fix',
      'Verify',
      'Approve',
      'Certify',
    ]);
    expect(screen.getAllByRole('link', { name: 'Create account' })[0]).toHaveAttribute(
      'href',
      '/en/register',
    );
    expect(screen.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute(
      'href',
      '/en/login',
    );
  });

  it('presents every section a visitor can jump to, with a footer', async () => {
    await renderHome('en');
    const en = LANDING_MESSAGES.en;
    await screen.findByRole('heading', { level: 1 });
    for (const title of [
      en.workflow.title,
      en.platform.title,
      en.solutions.title,
      en.value.title,
      en.trust.title,
      en.product.title,
      en.faq.title,
      en.cta.title,
    ]) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
    for (const id of ['how-it-works', 'platform', 'solutions', 'trust', 'faq']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    // One card per real module; none of them is a link to a page that does not exist.
    const modules = within(screen.getByRole('region', { name: en.platform.title }));
    expect(modules.getAllByRole('heading', { level: 3 })).toHaveLength(12);
    expect(modules.queryAllByRole('link')).toHaveLength(0);
  });

  it('links public certificate verification from the front door', async () => {
    await renderHome('en');
    const links = await screen.findAllByRole('link', { name: /verify a certificate/i });
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) expect(link).toHaveAttribute('href', '/en/verify');
  });

  it('labels the product previews as illustrations and hides them from assistive technology', async () => {
    const { container } = await renderHome('en');
    await screen.findByRole('heading', { level: 1 });
    const frames = container.querySelectorAll('.pc-lp-frame');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(LANDING_MESSAGES.en.hero.previewCaption)).toBeInTheDocument();
    expect(screen.getAllByText(LANDING_MESSAGES.en.product.sampleNote).length).toBeGreaterThan(0);
  });

  it('is in Arabic for the Arabic locale', async () => {
    await renderHome('ar');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      LANDING_MESSAGES.ar.hero.title,
    );
    expect(screen.getByText(LANDING_MESSAGES.ar.hero.lead)).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: SHELL_MESSAGES.ar.createAccount })[0],
    ).toHaveAttribute('href', '/ar/register');
  });

  it('asks for no personal data while signed out', async () => {
    await renderHome('en');
    await screen.findByRole('heading', { level: 1 });
    expect(api.documents).not.toHaveBeenCalled();
    expect(api.checks).not.toHaveBeenCalled();
  });
});

describe('HomePage, signed in', () => {
  beforeEach(() => {
    session.cookie = true;
  });

  it('welcomes the user by name and offers the first steps', async () => {
    api.me.mockResolvedValue(user());
    await renderHome('en');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Lina');
    const actions = screen.getByRole('group', { name: 'Quick actions' });
    expect(within(actions).getByRole('link', { name: /new document/i })).toHaveAttribute(
      'href',
      '/en/documents',
    );
    expect(within(actions).getByRole('link', { name: /start a check/i })).toHaveAttribute(
      'href',
      '/en/checks/new',
    );
  });

  it('says an empty account is empty rather than inventing numbers', async () => {
    api.me.mockResolvedValue(user());
    await renderHome('en');
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(await screen.findByText('No checks yet')).toBeInTheDocument();
    expect(screen.getByText('You are not a member of an organization')).toBeInTheDocument();
    // Nothing on the page is a count PalCert did not read.
    expect(screen.queryByText(/\b\d+%/)).toBeNull();
  });

  it('lists the real recent documents', async () => {
    api.me.mockResolvedValue(user());
    api.documents.mockResolvedValue({
      items: [
        {
          id: 'd-1',
          displayName: 'Thesis — final',
          status: 'ACTIVE',
          latestVersion: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    await renderHome('en');
    expect(await screen.findByRole('link', { name: 'Thesis — final' })).toHaveAttribute(
      'href',
      '/en/documents/d-1',
    );
  });

  it('keeps the rest of the dashboard when one list fails', async () => {
    api.me.mockResolvedValue(user());
    api.checks.mockRejectedValue(new Error('down'));
    await renderHome('en');
    expect(
      await screen.findByText(SHELL_MESSAGES.en.dashboardPage.couldNotLoad),
    ).toBeInTheDocument();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
  });

  it('does not read what the user may not read', async () => {
    api.me.mockResolvedValue(user({ permissions: ['profile:read:self'] }));
    await renderHome('en');
    await screen.findByRole('heading', { level: 1 });
    expect(api.documents).not.toHaveBeenCalled();
    expect(api.checks).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Quick actions' })).toBeNull();
  });
});

describe('HomePage, signed in with every personal permission', () => {
  beforeEach(() => {
    session.cookie = true;
  });

  const everything = [
    'document:read:self',
    'check:read:self',
    'submission:read:self',
    'certificate:read:self',
    'balance:read:self',
  ];

  it('shows the real submissions and certificates, and where to verify one', async () => {
    api.me.mockResolvedValue(user({ permissions: everything }));
    api.submissions.mockResolvedValue([
      {
        id: 's-1',
        organizationId: 'o-1',
        organizationName: 'Birzeit University',
        documentTypeId: 't-1',
        documentTypeName: 'Thesis',
        documentId: 'd-1',
        documentName: 'Thesis — final',
        currentRevision: null,
        revisionCount: 1,
        displayStatus: 'UNDER_REVIEW',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    api.certificates.mockResolvedValue([
      {
        id: 'c-1',
        certificateNumber: 'PC-2026-000123',
        issuanceStatus: 'ISSUED',
        organizationName: 'Birzeit University',
        revokedAt: null,
      },
    ]);
    await renderHome('en');
    expect(await screen.findByRole('link', { name: 'Thesis — final' })).toHaveAttribute(
      'href',
      '/en/submissions/s-1',
    );
    const number = await screen.findByText('PC-2026-000123');
    expect(number.closest('a')).toHaveAttribute('href', '/en/certificates/c-1');
    expect(screen.getByRole('link', { name: 'Verify a certificate' })).toHaveAttribute(
      'href',
      '/en/verify',
    );
  });

  it('shows the balance the ledger states', async () => {
    api.me.mockResolvedValue(user({ permissions: everything }));
    api.balance.mockResolvedValue({
      currency: 'USD',
      available: { currency: 'USD', minorUnits: '1025' },
      reserved: { currency: 'USD', minorUnits: '0' },
      cash: { currency: 'USD', minorUnits: '1025' },
      promotional: { currency: 'USD', minorUnits: '0' },
      accounts: [],
    });
    await renderHome('en');
    const figure = await screen.findByText(
      (_, node) => node?.getAttribute('data-minor-units') === '1025',
    );
    expect(figure).toHaveAttribute('data-currency', 'USD');
    expect(screen.getByRole('link', { name: 'View balance' })).toHaveAttribute(
      'href',
      '/en/balance',
    );
  });

  it('leaves the balance off rather than showing zero when it cannot be read', async () => {
    api.me.mockResolvedValue(user({ permissions: everything }));
    await renderHome('en');
    await screen.findByText('No submissions yet');
    expect(screen.queryByRole('heading', { name: 'Balance' })).toBeNull();
    expect(screen.queryByText(/0\.00/)).toBeNull();
  });

  it('does not read submissions, certificates or balance without permission', async () => {
    api.me.mockResolvedValue(user());
    await renderHome('en');
    await screen.findByText('No documents yet');
    expect(api.submissions).not.toHaveBeenCalled();
    expect(api.certificates).not.toHaveBeenCalled();
    expect(api.balance).not.toHaveBeenCalled();
  });
});

describe('LocaleLayout', () => {
  it('sets lang and dir to ltr for English', async () => {
    const element = (await LocaleLayout({
      children: null,
      params: Promise.resolve({ locale: 'en' }),
    })) as React.ReactElement<{ lang: string; dir: string }>;

    expect(element.props.lang).toBe('en');
    expect(element.props.dir).toBe('ltr');
  });

  it('sets lang and dir to rtl for Arabic', async () => {
    const element = (await LocaleLayout({
      children: null,
      params: Promise.resolve({ locale: 'ar' }),
    })) as React.ReactElement<{ lang: string; dir: string }>;

    expect(element.props.lang).toBe('ar');
    expect(element.props.dir).toBe('rtl');
  });
});
