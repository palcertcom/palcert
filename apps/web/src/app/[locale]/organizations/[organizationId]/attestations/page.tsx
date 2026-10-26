'use client';

import type {
  AttestationQueueCountsView,
  AttestationQueueEntryView,
  AttestationTypeView,
  OrganizationAttestationDashboardView,
} from '@palcert/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Figures,
  PaymentBadge,
  RequestStatusBadge,
  VerificationBadge,
  describeAttestationError,
  formatDate,
  money,
} from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { OrganizationShell } from '@/components/organization-shell';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { attestationReviewApi } from '@/lib/attestations-api';

const TABS = [
  'PENDING',
  'IN_REVIEW',
  'AWAITING_INFORMATION',
  'APPROVED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
  'ALL',
] as const;
type Tab = (typeof TABS)[number];
const COUNT_OF: Partial<Record<Tab, keyof AttestationQueueCountsView>> = {
  PENDING: 'pending',
  IN_REVIEW: 'inReview',
  AWAITING_INFORMATION: 'awaitingInformation',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
};
const SORTS = ['submittedAt:asc', 'submittedAt:desc', 'updatedAt:desc'] as const;
const PAGE_SIZE = 25;

/** The institution's attestation queue. */
export default function OrganizationAttestationsPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('attestation:request:read') ? (
          <Queue
            locale={locale}
            organizationId={organizationId}
            canManageTypes={permissions.has('attestation:type:manage')}
            canReadRevenue={permissions.has('attestation:finance:read')}
          />
        ) : (
          <>
            <PageHeader title={getAttestationsMessages(locale).queue.title} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        )
      }
    </OrganizationShell>
  );
}

function Queue({
  locale,
  organizationId,
  canManageTypes,
  canReadRevenue,
}: {
  locale: Locale;
  organizationId: string;
  canManageTypes: boolean;
  canReadRevenue: boolean;
}) {
  const messages = getAttestationsMessages(locale);
  const q = messages.queue;
  const base = `/${locale}/organizations/${organizationId}`;

  const [tab, setTab] = useState<Tab>('PENDING');
  const [sort, setSort] = useState<(typeof SORTS)[number]>('submittedAt:asc');
  const [typeId, setTypeId] = useState('');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<AttestationQueueEntryView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<AttestationQueueCountsView | null>(null);
  const [dashboard, setDashboard] = useState<OrganizationAttestationDashboardView | null>(null);
  const [types, setTypes] = useState<AttestationTypeView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    (cursor?: string) => {
      const [field, order] = sort.split(':') as ['submittedAt' | 'updatedAt', 'asc' | 'desc'];
      return attestationReviewApi.queue(organizationId, {
        status: tab,
        sort: field,
        order,
        limit: PAGE_SIZE,
        ...(typeId === '' ? {} : { attestationTypeId: typeId }),
        ...(search === '' ? {} : { search }),
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
    [organizationId, tab, sort, typeId, search],
  );

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void fetchPage()
      .then((page) => {
        if (cancelled) return;
        setRows([...page.items]);
        setNextCursor(page.nextCursor);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAttestationError(messages, caught));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, messages]);

  useEffect(() => {
    void attestationReviewApi
      .counts(organizationId)
      .then(setCounts)
      .catch(() => undefined);
    void attestationReviewApi
      .dashboard(organizationId)
      .then(setDashboard)
      .catch(() => undefined);
    if (canManageTypes)
      void attestationReviewApi
        .types(organizationId)
        .then(setTypes)
        .catch(() => undefined);
  }, [organizationId, canManageTypes]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await fetchPage(nextCursor);
      setRows((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }

  function applySearch(event: FormEvent): void {
    event.preventDefault();
    setSearch(draft.trim());
  }

  return (
    <>
      <PageHeader
        title={q.title}
        description={q.intro}
        actions={
          <>
            {canManageTypes ? (
              <Link className="pc-btn pc-btn-secondary" href={`${base}/attestation-types`}>
                {q.manageTypes}
              </Link>
            ) : null}
            {canReadRevenue ? (
              <Link className="pc-btn pc-btn-secondary" href={`${base}/attestation-revenue`}>
                {q.revenue}
              </Link>
            ) : null}
          </>
        }
      />
      {error === null ? null : <FormError message={error} />}

      {dashboard === null ? null : (
        <Figures
          label={q.title}
          items={[
            ...(
              [
                'pendingReview',
                'needsAttention',
                'approvedThisMonth',
                'rejectedThisMonth',
                'expiringSoon',
              ] as const
            ).map((key) => ({ key, label: q.dashboard[key], value: dashboard[key] })),
            ...(dashboard.revenueThisMonth === null
              ? []
              : dashboard.revenueThisMonth.map((row) => ({
                  key: `revenue-${row.institutionNet.currency}`,
                  label: q.dashboard.revenueThisMonth,
                  value: money(row.institutionNet, locale),
                }))),
          ]}
        />
      )}

      <div className="pc-tabs" role="group" aria-label={q.status}>
        {TABS.map((candidate) => {
          const countKey = COUNT_OF[candidate];
          const count = countKey === undefined || counts === null ? null : counts[countKey];
          return (
            <button
              key={candidate}
              type="button"
              className="pc-chip"
              aria-pressed={tab === candidate}
              onClick={() => setTab(candidate)}
              data-tab={candidate}
            >
              {q.tabs[candidate]}
              {count === null ? null : ` (${count})`}
            </button>
          );
        })}
      </div>

      <form className="pc-toolbar" role="search" onSubmit={applySearch}>
        <div className="pc-field">
          <label htmlFor="attestation-search">{q.searchLabel}</label>
          <input
            id="attestation-search"
            type="search"
            value={draft}
            maxLength={200}
            placeholder={q.searchHint}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <button type="submit" className="pc-btn pc-btn-secondary">
          {q.search}
        </button>
        {types.length === 0 ? null : (
          <div className="pc-field">
            <label htmlFor="attestation-type-filter">{q.typeFilter}</label>
            <select
              id="attestation-type-filter"
              value={typeId}
              onChange={(event) => setTypeId(event.target.value)}
            >
              <option value="">{q.allTypes}</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {locale === 'ar' ? type.nameAr : type.nameEn}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="pc-field">
          <label htmlFor="attestation-sort">{q.sortLabel}</label>
          <select
            id="attestation-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as (typeof SORTS)[number])}
          >
            {SORTS.map((value) => (
              <option key={value} value={value}>
                {q.sorts[value]}
              </option>
            ))}
          </select>
        </div>
      </form>

      {rows === null ? (
        <LoadingState label={messages.loading} />
      ) : rows.length === 0 ? (
        <EmptyState icon="review" title={q.emptyTitle} description={q.emptyHint} />
      ) : (
        <>
          <DataTable
            caption={q.title}
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'certificate',
                header: q.certificate,
                primary: true,
                cell: (row) => (
                  <span className="pc-cell-stack">
                    <Link href={`${base}/attestations/${row.id}`}>
                      <bdi>{row.certificateTitle}</bdi>
                    </Link>
                    {row.reference === null ? null : (
                      <code dir="ltr" className="pc-hint">
                        {row.reference}
                      </code>
                    )}
                    {row.duplicateArtifact ? (
                      <span
                        className="pc-hint"
                        title={q.duplicateHint}
                        data-testid="duplicate-flag"
                      >
                        {q.duplicate}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'applicant',
                header: q.applicant,
                cell: (row) => <bdi>{row.ownerDisplayName}</bdi>,
              },
              {
                key: 'type',
                header: q.type,
                cell: (row) => (
                  <bdi>
                    {locale === 'ar' ? row.attestationTypeName.ar : row.attestationTypeName.en}
                  </bdi>
                ),
              },
              {
                key: 'submitted',
                header: q.submitted,
                cell: (row) => formatDate(row.submittedAt, locale),
              },
              {
                key: 'reviewer',
                header: q.reviewer,
                cell: (row) =>
                  row.assignedReviewerName === null ? (
                    q.unassigned
                  ) : (
                    <bdi>{row.assignedReviewerName}</bdi>
                  ),
              },
              {
                key: 'fee',
                header: q.fee,
                align: 'end',
                cell: (row) => (
                  <span className="pc-cell-stack">
                    <span className="pc-money">{money(row.fee, locale)}</span>
                    <PaymentBadge status={row.paymentStatus} messages={messages} />
                  </span>
                ),
              },
              {
                key: 'status',
                header: q.status,
                cell: (row) =>
                  row.verificationStatus === null ? (
                    <RequestStatusBadge status={row.status} messages={messages} />
                  ) : (
                    <VerificationBadge status={row.verificationStatus} messages={messages} />
                  ),
              },
            ]}
          />
          {nextCursor === null ? null : (
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              onClick={() => void loadMore()}
            >
              {messages.loadMore}
            </button>
          )}
        </>
      )}
    </>
  );
}
