'use client';

import type {
  AttestationRequestListItemView,
  AttestationRequestStatus,
  AttestationRequestSummaryView,
} from '@palcert/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AttestationDisclaimer,
  Figures,
  RequestStatusBadge,
  VerificationBadge,
  describeAttestationError,
  formatDate,
  money,
} from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { resolveLocale } from '@/i18n/locales';
import { attestationsApi } from '@/lib/attestations-api';

const FILTERS: readonly (AttestationRequestStatus | undefined)[] = [
  undefined,
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'NEEDS_INFORMATION',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

/**
 * The certificates this person has asked institutions to attest.
 *
 * Each row says where the request stands and, once attested, whether the
 * attestation is valid, expired or revoked right now.
 */
export default function MyAttestationsPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const messages = getAttestationsMessages(locale);
  const m = messages.mine;

  const [filter, setFilter] = useState<AttestationRequestStatus | undefined>(undefined);
  const [rows, setRows] = useState<AttestationRequestListItemView[] | null>(null);
  const [summary, setSummary] = useState<AttestationRequestSummaryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void (async () => {
      try {
        const [list, counts] = await Promise.all([
          attestationsApi.list(filter),
          attestationsApi.summary(),
        ]);
        if (cancelled) return;
        setRows(list);
        setSummary(counts);
      } catch (caught) {
        if (!cancelled) setError(describeAttestationError(messages, caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, messages]);

  return (
    <main className="pc-page">
      <PageHeader
        title={m.title}
        description={m.intro}
        actions={
          <Link
            className="pc-btn"
            href={`/${locale}/attestations/new`}
            data-testid="new-attestation"
          >
            {m.newRequest}
          </Link>
        }
      />
      {error === null ? null : <FormError message={error} />}

      {summary === null ? null : (
        <Figures
          label={m.title}
          items={(
            [
              'valid',
              'expiringSoon',
              'pendingReview',
              'needsInformation',
              'expired',
              'rejected',
            ] as const
          ).map((key) => ({ key, label: m.summary[key], value: summary[key] }))}
        />
      )}

      <div className="pc-toolbar" role="group" aria-label={m.filterLabel}>
        {FILTERS.map((status) => (
          <button
            key={status ?? 'ALL'}
            type="button"
            className="pc-chip"
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
          >
            {status === undefined ? m.filterAll : (messages.statuses[status] ?? status)}
          </button>
        ))}
      </div>

      {rows === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : rows.length === 0 ? (
        <EmptyState icon="certificate" title={m.emptyTitle} description={m.emptyHint} />
      ) : (
        <DataTable
          caption={m.title}
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'certificate',
              header: m.certificate,
              primary: true,
              cell: (row) => (
                <span className="pc-cell-stack">
                  <Link href={`/${locale}/attestations/${row.id}`}>
                    <bdi>{row.certificateTitle}</bdi>
                  </Link>
                  {row.reference === null ? null : (
                    <code dir="ltr" className="pc-hint">
                      {row.reference}
                    </code>
                  )}
                </span>
              ),
            },
            {
              key: 'institution',
              header: m.institution,
              cell: (row) => (
                <span className="pc-cell-stack">
                  <bdi>{row.organizationName}</bdi>
                  <span className="pc-hint">
                    <bdi>
                      {locale === 'ar' ? row.attestationTypeName.ar : row.attestationTypeName.en}
                    </bdi>
                  </span>
                </span>
              ),
            },
            {
              key: 'status',
              header: m.status,
              cell: (row) =>
                row.verificationStatus === null ? (
                  <RequestStatusBadge status={row.status} messages={messages} />
                ) : (
                  <VerificationBadge status={row.verificationStatus} messages={messages} />
                ),
            },
            {
              key: 'validity',
              header: m.validity,
              cell: (row) =>
                row.attestationId === null
                  ? messages.none
                  : row.validUntil === null
                    ? messages.noExpiry
                    : formatDate(row.validUntil, locale),
            },
            {
              key: 'fee',
              header: m.fee,
              align: 'end',
              cell: (row) => (
                <span className="pc-cell-stack">
                  <span className="pc-money">{money(row.fee, locale)}</span>
                  <span className="pc-hint">
                    {messages.paymentStatuses[row.paymentStatus] ?? row.paymentStatus}
                  </span>
                </span>
              ),
            },
            {
              key: 'updated',
              header: m.updated,
              cell: (row) => (
                <time dateTime={row.updatedAt}>{formatDate(row.updatedAt, locale)}</time>
              ),
            },
          ]}
        />
      )}
      <AttestationDisclaimer messages={messages} />
    </main>
  );
}
