'use client';
import { AccountReports } from '@/components/account-reports';
import { OrganizationShell } from '@/components/organization-shell';
import { reportsMessages } from '@/i18n/reports-messages';
export default function ReportsPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('organization:withdrawal:read') ? (
          <AccountReports
            key={organizationId}
            locale={locale}
            base={`/organizations/${organizationId}/reports`}
            scope="organization"
          />
        ) : (
          <p role="alert">{reportsMessages(locale).denied}</p>
        )
      }
    </OrganizationShell>
  );
}
