'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import { resolveLocale } from '@/i18n/locales';
import { ApiError, certificatesApi, type CertificateResponse } from '@/lib/api-client';

/**
 * The certificates this person holds (§116).
 *
 * There is no "request a certificate" button, here or anywhere. A certificate
 * follows from an institution approving a compliant submission; offering to
 * generate one would be exactly the self-certification the design forbids.
 */
export default function CertificatesPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const messages = getCertificatesMessages(locale);

  const [certificates, setCertificates] = useState<CertificateResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await certificatesApi.list();
        if (!cancelled) setCertificates(rows);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? messages.genericError)
            : messages.genericError,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages]);

  const shell = getShellMessages(locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <main className="pc-page">
      <PageHeader
        title={messages.listTitle}
        description={messages.authorityNote}
        actions={
          <Link className="pc-btn pc-btn-secondary" href={`/${locale}/verify`}>
            {shell.verifyCertificate}
          </Link>
        }
      />
      {error === null ? null : <FormError message={error} />}

      {certificates === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : certificates.length === 0 ? (
        <EmptyState
          icon="certificate"
          title={shell.dashboardPage.noCertificates}
          description={shell.dashboardPage.noCertificatesHint}
        />
      ) : (
        <DataTable
          caption={messages.listTitle}
          rows={certificates}
          rowKey={(certificate) => certificate.id}
          columns={[
            {
              key: 'number',
              header: messages.certificateNumber,
              primary: true,
              cell: (certificate) => (
                <Link href={`/${locale}/certificates/${certificate.id}`}>
                  <code>{certificate.certificateNumber ?? certificate.id}</code>
                </Link>
              ),
            },
            {
              key: 'organization',
              header: messages.organization,
              cell: (certificate) => <bdi>{certificate.organizationName}</bdi>,
            },
            {
              key: 'standard',
              header: messages.standard,
              cell: (certificate) => (
                <span className="pc-cell-stack">
                  <bdi>{certificate.documentTypeName}</bdi>
                  <span className="pc-hint">
                    <bdi>{certificate.standardName}</bdi>{' '}
                    <bdi>{certificate.standardVersionLabel}</bdi>
                  </span>
                </span>
              ),
            },
            {
              key: 'issued',
              header: messages.issued,
              cell: (certificate) =>
                certificate.issuedAt === null ? (
                  '—'
                ) : (
                  <time dateTime={certificate.issuedAt}>
                    {when.format(new Date(certificate.issuedAt))}
                  </time>
                ),
            },
            {
              key: 'status',
              header: messages.statusLabel,
              cell: (certificate) => {
                const state =
                  certificate.revokedAt === null ? certificate.issuanceStatus : 'REVOKED';
                return (
                  <StatusBadge status={state} label={messages.issuanceStatuses[state] ?? state} />
                );
              },
            },
          ]}
        />
      )}
    </main>
  );
}
