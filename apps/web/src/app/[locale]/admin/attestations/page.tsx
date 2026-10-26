'use client';

import type { PlatformAttestationOverviewView } from '@palcert/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
import { Figures, describeAttestationError, money } from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { attestationAdminApi } from '@/lib/attestations-api';

/** PalCert-wide attestation finance: volumes, gross, commission and institution net. */
export default function AdminAttestationFinancePage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:attestation-finance:read')}>
      <Overview />
    </AdminGate>
  );
}

function Overview() {
  const locale = useAdminLocale();
  const messages = getAttestationsMessages(locale);
  const a = messages.admin;
  const { globalPermissions } = useShell();
  const canManage = globalPermissions.has('admin:attestation-commission:manage');
  const [data, setData] = useState<PlatformAttestationOverviewView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void attestationAdminApi
      .overview()
      .then(setData)
      .catch((caught: unknown) => setError(describeAttestationError(messages, caught)));
  }, [messages]);

  return (
    <main className="pc-page">
      <PageHeader title={a.financeTitle} description={a.financeIntro} />
      {error === null ? null : <FormError message={error} />}
      {data === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <>
          <Figures
            label={a.financeTitle}
            items={(
              ['requests', 'approvals', 'rejections', 'valid', 'expired', 'revoked'] as const
            ).map((key) => ({
              key,
              label: a[key],
              value: data[key],
            }))}
          />
          <section className="pc-card">
            <h2 className="pc-card-title">{a.byCurrency}</h2>
            {data.byCurrency.length === 0 ? (
              <p className="pc-hint">{a.emptyTitle}</p>
            ) : (
              <DataTable
                caption={a.byCurrency}
                rows={data.byCurrency}
                rowKey={(row) => row.currency}
                columns={[
                  {
                    key: 'currency',
                    header: messages.types.currency,
                    primary: true,
                    cell: (row) => row.currency,
                  },
                  {
                    key: 'gross',
                    header: a.gross,
                    align: 'end',
                    cell: (row) => money(row.gross, locale),
                  },
                  {
                    key: 'platform',
                    header: a.platformRevenue,
                    align: 'end',
                    cell: (row) => (
                      <span data-testid={`platform-${row.currency}`}>
                        {money(row.platformCommission, locale)}
                      </span>
                    ),
                  },
                  {
                    key: 'net',
                    header: a.institutionNet,
                    align: 'end',
                    cell: (row) => money(row.organizationNet, locale),
                  },
                ]}
              />
            )}
          </section>
          {data.organizations.length === 0 ? (
            <EmptyState icon="balance" title={a.emptyTitle} />
          ) : (
            <DataTable
              caption={a.organization}
              rows={data.organizations}
              rowKey={(row) => `${row.organizationId}:${row.currency}`}
              columns={[
                {
                  key: 'organization',
                  header: a.organization,
                  primary: true,
                  cell: (row) => (
                    <Link
                      href={`/${locale}/admin/organizations/${row.organizationId}/attestation-commission`}
                    >
                      <bdi>{row.organizationName}</bdi>
                    </Link>
                  ),
                },
                {
                  key: 'commission',
                  header: a.currentCommission,
                  cell: (row) => <span dir="ltr">{row.currentCommissionPercent}%</span>,
                },
                {
                  key: 'gross',
                  header: a.gross,
                  align: 'end',
                  cell: (row) => money(row.gross, locale),
                },
                {
                  key: 'platform',
                  header: a.platformRevenue,
                  align: 'end',
                  cell: (row) => money(row.platformRevenue, locale),
                },
                {
                  key: 'net',
                  header: a.institutionNet,
                  align: 'end',
                  cell: (row) => money(row.institutionNet, locale),
                },
                { key: 'approved', header: a.approvals, align: 'end', cell: (row) => row.approved },
                {
                  key: 'rejected',
                  header: a.rejections,
                  align: 'end',
                  cell: (row) => row.rejected,
                },
                { key: 'pending', header: a.pending, align: 'end', cell: (row) => row.pending },
                ...(canManage
                  ? [
                      {
                        key: 'manage',
                        header: a.manageCommission,
                        cell: (row: (typeof data.organizations)[number]) => (
                          <Link
                            className="pc-btn pc-btn-secondary pc-btn-sm"
                            href={`/${locale}/admin/organizations/${row.organizationId}/attestation-commission`}
                          >
                            {a.manageCommission}
                          </Link>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </>
      )}
    </main>
  );
}
