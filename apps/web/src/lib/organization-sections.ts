import { getApiClientsMessages } from '@/i18n/api-clients-messages';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import { getWebhooksMessages } from '@/i18n/webhooks-messages';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';

export type OrganizationSectionKey =
  | 'overview'
  | 'profile'
  | 'team'
  | 'invitations'
  | 'document-types'
  | 'standards'
  | 'submissions'
  | 'certificates'
  | 'attestations'
  | 'attestation-types'
  | 'payouts'
  | 'verification'
  | 'api-clients'
  | 'webhooks';

export interface OrganizationSection {
  readonly key: OrganizationSectionKey;
  readonly href: string;
  readonly label: string;
  /** The permission that makes the section worth offering. */
  readonly permission: string;
  /** Integrations sit in their own sidebar group; everything else is the workspace. */
  readonly group: 'workspace' | 'integrations';
}

/**
 * The organization's sections, filtered to what the caller can use.
 *
 * One definition, shared by the sidebar and the in-page navigation, so the two
 * cannot disagree. Hiding a link the caller cannot use is a courtesy, not a
 * control: the backend authorizes every request regardless of what the UI
 * renders. The permissions come from the server's role catalogue
 * (`permissionsForRoles`), never from a list kept here.
 *
 * Certificates are offered to whoever may read them (`certificate:record:read`,
 * the reviewing roles), which is the same permission that opens each one.
 */
export function organizationSections(
  locale: Locale,
  organizationId: string,
  permissions: ReadonlySet<string>,
): OrganizationSection[] {
  return allOrganizationSections(locale, organizationId).filter((section) =>
    permissions.has(section.permission),
  );
}

/** Every section, unfiltered: for naming a page, never for offering a link. */
export function allOrganizationSections(
  locale: Locale,
  organizationId: string,
): OrganizationSection[] {
  const organization = getOrganizationMessages(locale);
  const standards = getStandardsMessages(locale);
  const submissions = getSubmissionsMessages(locale);
  const webhooks = getWebhooksMessages(locale);
  const apiClients = getApiClientsMessages(locale);
  const certificates = getCertificatesMessages(locale);
  const attestations = getAttestationsMessages(locale);
  const withdrawals = getWithdrawalMessages(locale);
  const base = `/${locale}/organizations/${organizationId}`;

  return [
    {
      key: 'overview',
      href: base,
      label: organization.navOverview,
      permission: 'organization:profile:read',
      group: 'workspace',
    },
    {
      key: 'profile',
      href: `${base}/profile`,
      label: organization.navProfile,
      permission: 'organization:profile:read',
      group: 'workspace',
    },
    {
      key: 'team',
      href: `${base}/team`,
      label: organization.navTeam,
      permission: 'organization:member:read',
      group: 'workspace',
    },
    {
      key: 'invitations',
      href: `${base}/invitations`,
      label: organization.navInvitations,
      permission: 'organization:member:read',
      group: 'workspace',
    },
    {
      key: 'document-types',
      href: `${base}/document-types`,
      label: standards.navDocumentTypes,
      permission: 'standard:document-type:read',
      group: 'workspace',
    },
    {
      key: 'standards',
      href: `${base}/standards`,
      label: standards.navStandards,
      permission: 'standard:definition:read',
      group: 'workspace',
    },
    {
      key: 'submissions',
      href: `${base}/submissions`,
      label: submissions.queueTitle,
      permission: 'submission:review:read',
      group: 'workspace',
    },
    {
      key: 'certificates',
      href: `${base}/certificates`,
      label: certificates.register.title,
      permission: 'certificate:record:read',
      group: 'workspace',
    },
    {
      key: 'attestations',
      href: `${base}/attestations`,
      label: attestations.nav.queue,
      permission: 'attestation:request:read',
      group: 'workspace',
    },
    {
      key: 'attestation-types',
      href: `${base}/attestation-types`,
      label: attestations.nav.types,
      permission: 'attestation:type:manage',
      group: 'workspace',
    },
    {
      key: 'payouts',
      href: `${base}/payouts`,
      label: withdrawals.nav.organizationPayouts,
      permission: 'organization:withdrawal:read',
      group: 'workspace',
    },
    {
      key: 'verification',
      href: `${base}/verification`,
      label: organization.navVerification,
      permission: 'organization:verification:read',
      group: 'workspace',
    },
    {
      key: 'api-clients',
      href: `${base}/api-clients`,
      label: apiClients.navApiClients,
      permission: 'integration:api-client:read',
      group: 'integrations',
    },
    {
      key: 'webhooks',
      href: `${base}/webhooks`,
      label: webhooks.navWebhooks,
      permission: 'integration:webhook:read',
      group: 'integrations',
    },
  ];
}
