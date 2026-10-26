'use client';

import { WITHDRAWAL_CURRENCIES } from '@palcert/contracts/finance/withdrawals';
import { useMemo } from 'react';
import { OrganizationShell } from '@/components/organization-shell';
import { DestinationManager } from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { organizationPayoutsApi } from '@/lib/withdrawals-api';

/** Where this organization's payouts go. Managed only with the destination permission. */
export default function OrganizationPayoutDestinationsPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('organization:payout-destination:read') ? (
          <Destinations
            organizationId={organizationId}
            locale={locale}
            canManage={permissions.has('organization:payout-destination:manage')}
          />
        ) : (
          <>
            <PageHeader title={getWithdrawalMessages(locale).destinations.organizationTitle} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        )
      }
    </OrganizationShell>
  );
}

function Destinations({
  organizationId,
  locale,
  canManage,
}: {
  organizationId: string;
  locale: Locale;
  canManage: boolean;
}) {
  const messages = getWithdrawalMessages(locale);
  const api = useMemo(() => organizationPayoutsApi(organizationId), [organizationId]);
  return (
    <>
      <PageHeader
        title={messages.destinations.organizationTitle}
        description={messages.destinations.encryptedHint}
      />
      <DestinationManager
        api={api}
        locale={locale}
        title={messages.destinations.organizationTitle}
        canManage={canManage}
        currencies={WITHDRAWAL_CURRENCIES}
      />
    </>
  );
}
