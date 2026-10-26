'use client';

import type { OrganizationAttestationRevenueView } from '@palcert/contracts';
import Link from 'next/link';
import { OrganizationShell } from '@/components/organization-shell';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { AttestationRevenue } from '@/components/attestation-revenue';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { attestationReviewApi } from '@/lib/attestations-api';

/** What this institution earned from attestations, per request and in total. */
export default function AttestationRevenuePage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) => {
        const messages = getAttestationsMessages(locale);
        return permissions.has('attestation:finance:read') ? (
          <>
            <Link
              className="pc-back-link"
              href={`/${locale}/organizations/${organizationId}/attestations`}
            >
              {messages.review.backToQueue}
            </Link>
            <PageHeader title={messages.revenue.title} description={messages.revenue.intro} />
            <AttestationRevenue
              locale={locale}
              messages={messages}
              load={(params): Promise<OrganizationAttestationRevenueView> =>
                attestationReviewApi.revenue(organizationId, params)
              }
            />
          </>
        ) : (
          <>
            <PageHeader title={messages.revenue.title} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        );
      }}
    </OrganizationShell>
  );
}
