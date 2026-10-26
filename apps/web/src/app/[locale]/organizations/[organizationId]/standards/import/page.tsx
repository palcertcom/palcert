'use client';

import Link from 'next/link';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { StandardImportWizard } from '@/components/standard-transfer';
import { PageHeader } from '@/components/ui/page-header';
import { getStandardTransferMessages } from '@/i18n/standard-transfer-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';

function ImportStandard({ organizationId, permissions, locale }: OrganizationShellState) {
  const m = getStandardTransferMessages(locale);
  const sm = getStandardsMessages(locale);
  // The same permissions the import endpoints require. A reader who reaches
  // this address is told plainly rather than shown a form that cannot work.
  const canImport =
    permissions.has('standard:version:create') && permissions.has('standard:rule:write');

  return (
    <>
      <p className="pc-back-link">
        <Link href={`/${locale}/organizations/${organizationId}/standards`}>
          {sm.standardsTitle}
        </Link>
      </p>
      <PageHeader title={m.importTitle} description={m.importIntro} />
      {canImport ? (
        <StandardImportWizard
          organizationId={organizationId}
          locale={locale}
          canCreateStandard={permissions.has('standard:definition:create')}
        />
      ) : (
        <p className="pc-alert pc-alert-error" role="alert">
          {m.errors.PERMISSION_DENIED}
        </p>
      )}
    </>
  );
}

export default function ImportStandardPage() {
  return <OrganizationShell>{(state) => <ImportStandard {...state} />}</OrganizationShell>;
}
