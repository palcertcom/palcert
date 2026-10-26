'use client';

import Link from 'next/link';
import { OrganizationShell } from '@/components/organization-shell';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { labelFor } from '@/i18n/organization-messages';
import { organizationSections } from '@/lib/organization-sections';
import { SECTION_ICONS } from '@/lib/shell-navigation';

/**
 * The organization's front page: who it is, as the API states it, and the
 * sections this member can open — the same permission-filtered list the
 * sidebar shows. No activity totals: the API reports none, so none are drawn.
 */
export default function OrganizationOverviewPage() {
  return (
    <OrganizationShell>
      {({ organization, organizationId, messages, locale, permissions }) => {
        const sections = organizationSections(locale, organizationId, permissions).filter(
          (section) => section.key !== 'overview',
        );
        return (
          <>
            <PageHeader title={messages.overviewTitle} />
            <div className="pc-detail-grid">
              <section className="pc-card" aria-labelledby="org-details-heading">
                <h2 id="org-details-heading" className="pc-card-title">
                  {messages.navProfile}
                </h2>
                <dl className="pc-summary">
                  <dt>{messages.organizationType}</dt>
                  <dd>{labelFor(messages.typeLabels, organization.type)}</dd>
                  <dt>{messages.country}</dt>
                  <dd>{organization.countryCode}</dd>
                  <dt>{messages.timezone}</dt>
                  <dd>
                    <bdi>{organization.timezone}</bdi>
                  </dd>
                  <dt>{messages.memberCount}</dt>
                  <dd>{organization.memberCount}</dd>
                  <dt>{messages.navVerification}</dt>
                  <dd>{labelFor(messages.verificationLabels, organization.verificationStatus)}</dd>
                  <dt>{messages.created}</dt>
                  <dd>
                    {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                      new Date(organization.createdAt),
                    )}
                  </dd>
                </dl>
              </section>

              {sections.length > 0 && (
                <nav className="pc-card pc-org-sections" aria-labelledby="org-sections-heading">
                  <h2 id="org-sections-heading" className="pc-card-title">
                    {messages.organizationSections}
                  </h2>
                  <ul>
                    {sections.map((section) => (
                      <li key={section.key}>
                        <Link href={section.href}>
                          <Icon name={SECTION_ICONS[section.key]} size={18} />
                          <span>{section.label}</span>
                          <Icon name="chevron" size={16} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
            </div>
          </>
        );
      }}
    </OrganizationShell>
  );
}
