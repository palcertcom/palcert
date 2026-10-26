import { describe, expect, it } from 'vitest';
import { SHELL_MESSAGES } from '@/i18n/shell-messages';
import { breadcrumbsFor } from '../breadcrumbs';
import { permissionsForRoles } from '../organization-permissions';
import {
  buildNavigation,
  isActive,
  organizationIdFromPath,
  pathInLocale,
  routeKind,
  type NavGroup,
} from '../shell-navigation';
import { toneForStatus } from '../status-tone';

/** The self-service permissions `/users/me` reports for an ordinary user. */
const SELF = new Set([
  'profile:read:self',
  'session:read:self',
  'document:read:self',
  'document:write:self',
  'check:read:self',
  'check:create:self',
  'submission:read:self',
  'certificate:read:self',
  'balance:read:self',
  'notification:read:self',
]);

function hrefs(groups: NavGroup[]): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.href));
}

describe('buildNavigation', () => {
  it('gives an ordinary user every personal section, including submissions', () => {
    const groups = buildNavigation({
      locale: 'en',
      globalPermissions: SELF,
      organizationId: null,
      organizationPermissions: new Set(),
      unreadNotifications: null,
    });

    expect(hrefs(groups)).toEqual([
      '/en',
      '/en/documents',
      '/en/checks',
      '/en/certificates',
      '/en/submissions',
      '/en/balance',
      '/en/notifications',
      '/en/organizations',
      '/en/profile',
      '/en/sessions',
    ]);
  });

  it('never puts public verification in the signed-in navigation', () => {
    const groups = buildNavigation({
      locale: 'en',
      globalPermissions: SELF,
      organizationId: 'org-1',
      organizationPermissions: permissionsForRoles(['ORGANIZATION_OWNER']),
      unreadNotifications: 2,
    });

    expect(hrefs(groups).some((href) => href.includes('/verify'))).toBe(false);
  });

  it('offers organization certificates to the roles that may read them, and no one else', () => {
    const certificates = (roles: string[]) =>
      hrefs(
        buildNavigation({
          locale: 'en',
          globalPermissions: SELF,
          organizationId: 'org-1',
          organizationPermissions: permissionsForRoles(roles),
          unreadNotifications: null,
        }),
      ).includes('/en/organizations/org-1/certificates');

    expect(certificates(['ORGANIZATION_OWNER'])).toBe(true);
    expect(certificates(['ORGANIZATION_REVIEWER'])).toBe(true);
    // Authoring standards is not reviewing: no certificate:record:read.
    expect(certificates(['TEMPLATE_MANAGER'])).toBe(false);
  });

  it('shows nothing personal a user has no permission for', () => {
    const groups = buildNavigation({
      locale: 'en',
      globalPermissions: new Set(['profile:read:self']),
      organizationId: null,
      organizationPermissions: new Set(),
      unreadNotifications: null,
    });

    expect(groups.find((group) => group.id === 'personal')).toBeUndefined();
    expect(hrefs(groups)).toEqual(['/en', '/en/organizations', '/en/profile']);
  });

  it('draws organization sections from the roles held in that organization', () => {
    const reviewer = buildNavigation({
      locale: 'en',
      globalPermissions: SELF,
      organizationId: 'org-1',
      organizationPermissions: permissionsForRoles(['ORGANIZATION_REVIEWER']),
      unreadNotifications: null,
    });
    const reviewerHrefs = hrefs(reviewer);
    expect(reviewerHrefs).toContain('/en/organizations/org-1/submissions');
    expect(reviewerHrefs).not.toContain('/en/organizations/org-1/api-clients');
    expect(reviewer.find((group) => group.id === 'integrations')).toBeUndefined();

    const owner = buildNavigation({
      locale: 'en',
      globalPermissions: SELF,
      organizationId: 'org-1',
      organizationPermissions: permissionsForRoles(['ORGANIZATION_OWNER']),
      unreadNotifications: null,
    });
    expect(owner.find((group) => group.id === 'integrations')?.items.length).toBeGreaterThan(0);
  });

  it('carries the real unread count, and no badge when there is none', () => {
    const withUnread = buildNavigation({
      locale: 'en',
      globalPermissions: SELF,
      organizationId: null,
      organizationPermissions: new Set(),
      unreadNotifications: 4,
    });
    const inbox = withUnread.flatMap((g) => g.items).find((i) => i.href === '/en/notifications');
    expect(inbox?.badge).toBe(4);

    const none = buildNavigation({
      locale: 'en',
      globalPermissions: SELF,
      organizationId: null,
      organizationPermissions: new Set(),
      unreadNotifications: 0,
    });
    const quiet = none.flatMap((g) => g.items).find((i) => i.href === '/en/notifications');
    expect(quiet?.badge).toBeUndefined();
  });

  it('labels everything in Arabic for the Arabic locale', () => {
    const groups = buildNavigation({
      locale: 'ar',
      globalPermissions: SELF,
      organizationId: null,
      organizationPermissions: new Set(),
      unreadNotifications: null,
    });
    const labels = groups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toContain(SHELL_MESSAGES.ar.submissions);
    expect(hrefs(groups).every((href) => href.startsWith('/ar'))).toBe(true);
  });
});

describe('isActive', () => {
  const documents = {
    href: '/en/documents',
    label: '',
    icon: 'document',
    matchPrefix: true,
  } as const;
  const home = { href: '/en', label: '', icon: 'dashboard', matchPrefix: false } as const;

  it('matches a section and the pages under it', () => {
    expect(isActive(documents, '/en/documents')).toBe(true);
    expect(isActive(documents, '/en/documents/abc')).toBe(true);
    expect(isActive(documents, '/en/documents-archive')).toBe(false);
  });

  it('matches the dashboard only exactly', () => {
    expect(isActive(home, '/en')).toBe(true);
    expect(isActive(home, '/en/documents')).toBe(false);
  });
});

describe('route helpers', () => {
  it('reads the organization from the path, but not the creation page', () => {
    expect(organizationIdFromPath('/en/organizations/org-1/team')).toBe('org-1');
    expect(organizationIdFromPath('/ar/organizations/org-1')).toBe('org-1');
    expect(organizationIdFromPath('/en/organizations/new')).toBeNull();
    expect(organizationIdFromPath('/en/organizations')).toBeNull();
  });

  it('switches locale without losing the page', () => {
    expect(pathInLocale('/en/documents/abc', 'ar')).toBe('/ar/documents/abc');
    expect(pathInLocale('/ar', 'en')).toBe('/en');
  });

  it('frames sign-in pages, public pages and the application differently', () => {
    expect(routeKind('/en/login')).toBe('auth');
    expect(routeKind('/ar/mfa/enroll')).toBe('auth');
    expect(routeKind('/en/invitations/accept')).toBe('auth');
    expect(routeKind('/en/verify')).toBe('public');
    expect(routeKind('/en/verify/PC-123')).toBe('public');
    expect(routeKind('/en/unauthorized')).toBe('public');
    expect(routeKind('/en/verify-email')).toBe('auth');
    expect(routeKind('/en')).toBe('app');
    expect(routeKind('/en/documents')).toBe('app');
  });
});

describe('breadcrumbsFor', () => {
  it('has no trail on top-level pages', () => {
    expect(breadcrumbsFor('/en', 'en')).toEqual([]);
    expect(breadcrumbsFor('/en/documents', 'en')).toEqual([]);
  });

  it('names an entity generically and never links the current page', () => {
    expect(breadcrumbsFor('/en/documents/abc', 'en')).toEqual([
      { label: 'Documents', href: '/en/documents' },
      { label: 'Document' },
    ]);
  });

  it('uses the organization name it knows, and the section label', () => {
    expect(
      breadcrumbsFor('/en/organizations/org-1/standards/s-1/versions/v-1', 'en', 'Birzeit'),
    ).toEqual([
      { label: 'Organizations', href: '/en/organizations' },
      { label: 'Birzeit', href: '/en/organizations/org-1' },
      { label: 'Standards', href: '/en/organizations/org-1/standards' },
      { label: 'Standard', href: '/en/organizations/org-1/standards/s-1' },
      { label: 'Version' },
    ]);
  });
});

describe('toneForStatus', () => {
  it('maps lifecycle states to a tone and anything unknown to neutral', () => {
    expect(toneForStatus('ISSUED')).toBe('success');
    expect(toneForStatus('REVOKED')).toBe('danger');
    expect(toneForStatus('SOMETHING_NEW')).toBe('neutral');
  });
});

describe('shell messages', () => {
  it('has every key in every locale', () => {
    const keys = (value: object): string[] =>
      Object.entries(value)
        .flatMap(([key, entry]) =>
          entry !== null && typeof entry === 'object'
            ? keys(entry).map((inner) => `${key}.${inner}`)
            : [key],
        )
        .sort();
    expect(keys(SHELL_MESSAGES.ar)).toEqual(keys(SHELL_MESSAGES.en));
  });

  it('keeps the wording QA and the rest of the product rely on', () => {
    expect(SHELL_MESSAGES.en.signIn).toBe('Sign in');
    expect(SHELL_MESSAGES.en.signOut).toBe('Sign out');
    expect(SHELL_MESSAGES.ar.signOut).toBe('تسجيل الخروج');
  });
});
