import type { Locale } from '@/i18n/locales';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getEmailMessages } from '@/i18n/email-messages';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import { allOrganizationSections } from './organization-sections';

export interface Crumb {
  readonly label: string;
  /** Absent for the page the reader is on. */
  readonly href?: string;
}

/**
 * The trail above a page, worked out from its address alone.
 *
 * Entities the shell has not loaded are named generically ("Document",
 * "Standard") rather than fetched: the page below says which one it is, and
 * the shell must not make its own requests for every record a page shows.
 * The one name it does know is the current organization's, from the
 * memberships it already holds.
 *
 * Top-level pages (the dashboard, a section's own list) get no trail: the
 * sidebar already says where the reader is.
 */
export function breadcrumbsFor(
  pathname: string,
  locale: Locale,
  organizationName: string | null = null,
): Crumb[] {
  const m = getShellMessages(locale);
  const base = `/${locale}`;
  const parts = pathname
    .replace(/^\/[a-z]{2}(?=\/|$)/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return [];

  const [head, second, third, fourth, fifth, sixth] = parts;
  const trail = (...crumbs: Crumb[]): Crumb[] => {
    // The last crumb is the current page and is never a link.
    const last = crumbs[crumbs.length - 1]!;
    return [...crumbs.slice(0, -1), { label: last.label }];
  };

  switch (head) {
    case 'admin': {
      const admin = getAdminMessages(locale);
      const root = { label: admin.nav.overview, href: `${base}/admin` };
      const sections: Record<string, string> = {
        organizations: admin.nav.organizations,
        users: admin.nav.users,
        finance: admin.nav.finance,
        attestations: getAttestationsMessages(locale).nav.adminFinance,
        'email-settings': getEmailMessages(locale).nav.settings,
        'email-deliveries': getEmailMessages(locale).nav.deliveries,
        'top-ups': getManualTopUpMessages(locale).nav.adminQueue,
        'payment-methods': getManualTopUpMessages(locale).nav.adminMethods,
        withdrawals: getWithdrawalMessages(locale).nav.adminQueue,
        'platform-funds': getWithdrawalMessages(locale).nav.platformFunds,
        'withdrawal-settings': getWithdrawalMessages(locale).nav.settings,
      };
      const label = second === undefined ? undefined : sections[second];
      if (label === undefined) return [];
      const section = { label, href: `${base}/admin/${second}` };
      if (third === undefined) return trail(root, section);
      if (second === 'finance' && third === 'customers') {
        return trail(root, section, { label: admin.customer.title });
      }
      if (second === 'top-ups') {
        return trail(root, section, { label: getManualTopUpMessages(locale).admin.requestTitle });
      }
      if (second === 'withdrawals') {
        return trail(root, section, { label: getWithdrawalMessages(locale).detail.summary });
      }
      return trail(root, section, {
        label: second === 'organizations' ? m.entities.organization : admin.user.account,
      });
    }
    case 'documents':
      return trail(
        { label: m.documents, href: `${base}/documents` },
        { label: m.entities.document },
      );
    case 'checks':
      return trail(
        { label: m.checks, href: `${base}/checks` },
        { label: second === 'new' ? m.entities.newCheck : m.entities.check },
      );
    case 'certificates':
      return trail(
        { label: m.certificates, href: `${base}/certificates` },
        { label: m.entities.certificate },
      );
    case 'submissions':
      return trail(
        { label: m.submissions, href: `${base}/submissions` },
        { label: m.entities.submission },
      );
    case 'attestations': {
      const attestations = getAttestationsMessages(locale);
      return trail(
        { label: attestations.nav.mine, href: `${base}/attestations` },
        { label: second === 'new' ? attestations.wizard.title : attestations.details.requestTitle },
      );
    }
    case 'balance': {
      const balance = { label: m.balance, href: `${base}/balance` };
      const topUps = getManualTopUpMessages(locale);
      if (second === 'add') return trail(balance, { label: topUps.nav.addBalance });
      const withdrawals = getWithdrawalMessages(locale);
      if (second === 'withdraw') return trail(balance, { label: withdrawals.nav.withdraw });
      if (second === 'payout-destinations') {
        return trail(balance, { label: withdrawals.nav.destinations });
      }
      if (second === 'withdrawals') {
        const history = { label: withdrawals.nav.history, href: `${base}/balance/withdrawals` };
        return third === undefined
          ? trail(balance, history)
          : trail(balance, history, { label: withdrawals.detail.summary });
      }
      if (second === 'top-ups') {
        const history = { label: topUps.nav.history, href: `${base}/balance/top-ups` };
        return third === undefined
          ? trail(balance, history)
          : trail(balance, history, { label: topUps.nav.request });
      }
      return trail(balance, {
        label:
          second === 'payment-cancelled' ? m.entities.paymentCancelled : m.entities.paymentReturn,
      });
    }
    case 'notifications':
      return trail(
        { label: m.notifications, href: `${base}/notifications` },
        { label: m.entities.preferences },
      );
    case 'organizations': {
      const all = { label: m.organizations, href: `${base}/organizations` };
      if (second === 'new') return trail(all, { label: m.entities.newOrganization });
      const orgBase = `${base}/organizations/${second}`;
      const organization = {
        label: organizationName ?? m.entities.organization,
        href: orgBase,
      };
      if (third === undefined) return trail(all, organization);

      const section = allOrganizationSections(locale, second!).find((entry) => entry.key === third);
      if (section === undefined) return trail(all, organization);
      const sectionCrumb = { label: section.label, href: section.href };
      if (fourth === undefined) return trail(all, organization, sectionCrumb);

      switch (third) {
        case 'standards': {
          const standard = { label: m.entities.standard, href: `${orgBase}/standards/${fourth}` };
          if (fifth === 'versions' && sixth !== undefined) {
            return trail(all, organization, sectionCrumb, standard, { label: m.entities.version });
          }
          return trail(all, organization, sectionCrumb, standard);
        }
        case 'submissions':
          return trail(all, organization, sectionCrumb, { label: m.entities.submission });
        case 'webhooks':
          return trail(all, organization, sectionCrumb, { label: m.entities.endpoint });
        case 'certificates':
          return trail(all, organization, sectionCrumb, { label: m.entities.certificate });
        case 'attestations':
          return trail(all, organization, sectionCrumb, {
            label: getAttestationsMessages(locale).details.requestTitle,
          });
        default:
          return trail(all, organization, sectionCrumb);
      }
    }
    default:
      return [];
  }
}
