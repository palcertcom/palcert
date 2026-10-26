import type { IconName } from '@/components/ui/icon';
import type { Locale } from '@/i18n/locales';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getEmailMessages } from '@/i18n/email-messages';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import { organizationSections, type OrganizationSectionKey } from './organization-sections';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** Matches deeper routes too (a document page highlights "Documents"). */
  readonly matchPrefix: boolean;
  readonly badge?: number;
}

export interface NavGroup {
  readonly id: 'main' | 'personal' | 'organization' | 'integrations' | 'account' | 'administration';
  readonly label: string | null;
  readonly items: readonly NavItem[];
}

export const SECTION_ICONS: Record<OrganizationSectionKey, IconName> = {
  overview: 'organization',
  profile: 'types',
  team: 'team',
  invitations: 'invitation',
  'document-types': 'types',
  standards: 'standard',
  submissions: 'review',
  certificates: 'certificate',
  attestations: 'verified',
  'attestation-types': 'types',
  verification: 'verified',
  payouts: 'balance',
  'api-clients': 'key',
  webhooks: 'webhook',
};

/**
 * The sidebar's contents for one user, derived rather than hard-coded.
 *
 * Personal entries follow the permissions `/users/me` reports (computed by the
 * server from the user's roles); organization entries follow the permissions
 * of the user's roles *in the current organization*, taken from the shared
 * role catalogue. Nothing here grants anything: every page and every request
 * is authorized again by the API, and a hidden link is only a courtesy.
 */
export function buildNavigation(input: {
  locale: Locale;
  globalPermissions: ReadonlySet<string>;
  organizationId: string | null;
  organizationPermissions: ReadonlySet<string>;
  unreadNotifications: number | null;
}): NavGroup[] {
  const { locale, globalPermissions: can } = input;
  const m = getShellMessages(locale);
  const base = `/${locale}`;

  const personal: NavItem[] = [];
  const add = (permission: string, item: NavItem) => {
    if (can.has(permission)) personal.push(item);
  };
  add('document:read:self', {
    href: `${base}/documents`,
    label: m.documents,
    icon: 'document',
    matchPrefix: true,
  });
  add('check:read:self', {
    href: `${base}/checks`,
    label: m.checks,
    icon: 'check',
    matchPrefix: true,
  });
  add('certificate:read:self', {
    href: `${base}/certificates`,
    label: m.certificates,
    icon: 'certificate',
    matchPrefix: true,
  });
  add('submission:read:self', {
    href: `${base}/submissions`,
    label: m.submissions,
    icon: 'submission',
    matchPrefix: true,
  });
  add('attestation:read:self', {
    href: `${base}/attestations`,
    label: getAttestationsMessages(locale).nav.mine,
    icon: 'verified',
    matchPrefix: true,
  });
  add('balance:read:self', {
    href: `${base}/balance`,
    label: m.balance,
    icon: 'balance',
    matchPrefix: true,
  });
  add('notification:read:self', {
    href: `${base}/notifications`,
    label: m.notifications,
    icon: 'bell',
    matchPrefix: true,
    ...(input.unreadNotifications !== null && input.unreadNotifications > 0
      ? { badge: input.unreadNotifications }
      : {}),
  });

  const groups: NavGroup[] = [
    {
      id: 'main',
      label: null,
      items: [{ href: base, label: m.dashboard, icon: 'dashboard', matchPrefix: false }],
    },
  ];
  if (personal.length > 0) groups.push({ id: 'personal', label: m.groupPersonal, items: personal });

  if (input.organizationId !== null) {
    const sections = organizationSections(
      locale,
      input.organizationId,
      input.organizationPermissions,
    );
    const toItem = (section: (typeof sections)[number]): NavItem => ({
      href: section.href,
      label: section.label,
      icon: SECTION_ICONS[section.key],
      // The overview is the organization's root; only it must match exactly.
      matchPrefix: section.key !== 'overview',
    });
    groups.push({
      id: 'organization',
      label: m.groupOrganization,
      items: sections.filter((section) => section.group === 'workspace').map(toItem),
    });
    const integrations = sections.filter((section) => section.group === 'integrations');
    if (integrations.length > 0) {
      groups.push({
        id: 'integrations',
        label: m.groupIntegrations,
        items: integrations.map(toItem),
      });
    }
  } else {
    groups.push({
      id: 'organization',
      label: m.groupOrganization,
      items: [
        {
          href: `${base}/organizations`,
          label: m.organizations,
          icon: 'organization',
          matchPrefix: false,
        },
      ],
    });
  }

  const account: NavItem[] = [];
  if (can.has('profile:read:self')) {
    account.push({ href: `${base}/profile`, label: m.profile, icon: 'user', matchPrefix: true });
  }
  if (can.has('session:read:self')) {
    account.push({
      href: `${base}/sessions`,
      label: m.sessions,
      icon: 'sessions',
      matchPrefix: true,
    });
  }
  if (account.length > 0) groups.push({ id: 'account', label: m.groupAccount, items: account });

  const administration = adminNavigation(locale, can);
  if (administration.length > 0) {
    groups.push({
      id: 'administration',
      label: getAdminMessages(locale).groupLabel,
      items: administration,
    });
  }

  return groups;
}

/**
 * The staff console's entries, from the PalCert-wide permissions `/users/me`
 * reports. Nobody outside PalCert staff holds any of these, so ordinary users
 * never see the group; each staff role sees only the areas it may read.
 */
export function adminNavigation(locale: Locale, can: ReadonlySet<string>): NavItem[] {
  const m = getAdminMessages(locale).nav;
  const base = `/${locale}/admin`;
  const items: NavItem[] = [];
  if (can.has('admin:organization:read') && can.has('admin:user:read')) {
    items.push({ href: base, label: m.overview, icon: 'shield', matchPrefix: false });
  }
  if (can.has('admin:organization:read')) {
    items.push({
      href: `${base}/organizations`,
      label: m.organizations,
      icon: 'organization',
      matchPrefix: true,
    });
  }
  if (can.has('admin:user:read')) {
    items.push({ href: `${base}/users`, label: m.users, icon: 'team', matchPrefix: true });
  }
  if (FINANCE_READ.some((permission) => can.has(permission))) {
    items.push({ href: `${base}/finance`, label: m.finance, icon: 'balance', matchPrefix: true });
  }
  if (can.has('finance:manual-topup:read')) {
    items.push({
      href: `${base}/top-ups`,
      label: getManualTopUpMessages(locale).nav.adminQueue,
      icon: 'review',
      matchPrefix: true,
    });
  }
  if (can.has('finance:withdrawal:read')) {
    const withdrawals = getWithdrawalMessages(locale).nav;
    items.push(
      {
        href: `${base}/withdrawals`,
        label: withdrawals.adminQueue,
        icon: 'review',
        matchPrefix: true,
      },
      {
        href: `${base}/platform-funds`,
        label: withdrawals.platformFunds,
        icon: 'balance',
        matchPrefix: true,
      },
      {
        href: `${base}/withdrawal-settings`,
        label: withdrawals.settings,
        icon: 'shield',
        matchPrefix: true,
      },
    );
  }
  if (can.has('admin:payment-method:read')) {
    items.push({
      href: `${base}/payment-methods`,
      label: getManualTopUpMessages(locale).nav.adminMethods,
      icon: 'balance',
      matchPrefix: true,
    });
  }
  if (can.has('admin:attestation-finance:read')) {
    items.push({
      href: `${base}/attestations`,
      label: getAttestationsMessages(locale).nav.adminFinance,
      icon: 'verified',
      matchPrefix: true,
    });
  }
  if (can.has('admin:email-settings:read')) {
    items.push({
      href: `${base}/email-settings`,
      label: getEmailMessages(locale).nav.settings,
      icon: 'invitation',
      matchPrefix: true,
    });
  }
  if (can.has('admin:email-delivery:read')) {
    items.push({
      href: `${base}/email-deliveries`,
      label: getEmailMessages(locale).nav.deliveries,
      icon: 'history',
      matchPrefix: true,
    });
  }
  return items;
}

/** Any one of these makes the finance console worth opening. */
export const FINANCE_READ = [
  'pricing:price:read',
  'finance:payment:read',
  'finance:ledger:read',
  'finance:purchase:read',
] as const;

/** Whether a navigation item is the one the current path belongs to. */
export function isActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href) return true;
  return item.matchPrefix && pathname.startsWith(`${item.href}/`);
}

/** The organization id in a path such as `/en/organizations/<id>/team`, if any. */
export function organizationIdFromPath(pathname: string): string | null {
  const match = /^\/[a-z]{2}\/organizations\/([^/]+)/.exec(pathname);
  if (match === null || match[1] === 'new') return null;
  return decodeURIComponent(match[1]!);
}

/** The same page in another locale. */
export function pathInLocale(pathname: string, locale: Locale): string {
  const rest = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '');
  return `/${locale}${rest}`;
}

/** Which frame a route is drawn in. */
export type RouteKind = 'auth' | 'public' | 'app';

const AUTH_ROUTES = [
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'verify-email',
  'mfa',
  'invitations/accept',
];

const PUBLIC_ROUTES = ['verify', 'certificate-attestation', 'unauthorized', 'forbidden'];

function routeRest(pathname: string): string {
  return pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '').replace(/^\/+|\/+$/g, '');
}

function under(rest: string, route: string): boolean {
  return rest === route || rest.startsWith(`${route}/`);
}

/**
 * Sign-in pages get the split sign-in frame; public pages (certificate
 * verification, the page explaining certificate attestation, the access
 * pages) get a light public frame with no account
 * navigation; everything else is the application.
 */
export function routeKind(pathname: string): RouteKind {
  const rest = routeRest(pathname);
  if (AUTH_ROUTES.some((route) => under(rest, route))) return 'auth';
  if (PUBLIC_ROUTES.some((route) => under(rest, route))) return 'public';
  return 'app';
}

export function isAuthPath(pathname: string): boolean {
  return routeKind(pathname) === 'auth';
}
